package expo.modules.ridebarometer

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Sized to hold one whole hardware FIFO flush, which is the largest burst that
// can arrive at once. The Pixel 10 Pro's barometer reports
// `FIFO (max,reserved) = (3000, 3000) events`, and a non-wake sensor fills that
// FIFO while the SoC is suspended then delivers the lot on wake. At 1024 the
// ring would keep only the newest third of such a flush, and `expo-location`
// batches its own locations across the same suspend -- so the older locations in
// that batch would be asking for readings that had just been evicted.
//
// 4096 covers a full flush with headroom, and is about 2.7 minutes of history at
// the 5Hz this module asks for. Two primitive arrays, roughly 64KB, which is
// nothing against the reason for having it.
private const val RING_CAPACITY = 4096

// Guard rails on the sampling period. Below 20ms (50Hz) a pressure sensor is
// reporting its own noise faster than the air changes, and above 2s there is
// nothing left to average per fix.
private const val MIN_INTERVAL_MS = 20
private const val MAX_INTERVAL_MS = 2_000

// How far back and forward a reading's derived wall-clock time may land before
// it is treated as a broken clock rather than an old reading.
//
// THIS IS A BACKSTOP, NOT THE FILTER, and getting that backwards has now cost
// two revisions. The filter is `altitudeAtFix`, which averages only readings
// within +/-500ms of a fix's own timestamp. An old reading is therefore already
// handled correctly by doing nothing: it matches no fix's window and is ignored.
// Repairing it to "now" is what breaks that, because it drags a reading from
// minutes ago into the current fix's mean.
//
// So this exists for one case only: a device whose sensor clock is on a
// different BASE from its boot clock, where every reading is unusable and the
// barometer would otherwise contribute nothing at all. Stamping those "now"
// degrades to "the newest readings", which is what the old accumulator did, and
// is better than silence.
//
// THE SIZE COMES FROM THE HARDWARE, measured on the Pixel 10 Pro this is being
// tested on:
//
//   SPL07003 Barometer | continuous | minRate=1.00Hz | maxRate=25.00Hz
//   FIFO (max,reserved) = (3000, 3000) events | non-wakeUp
//
// A 3000-event FIFO is ten minutes of buffering at the 5Hz this module asks
// for, and fifty minutes at the 1Hz floor. Non-wake sensors keep filling that
// FIFO while the SoC is suspended and flush it on wake, so readings legitimately
// arrive carrying true timestamps many minutes old. The previous value of five
// seconds would have stamped every one of them "now" -- hundreds of readings
// spanning minutes, all collapsed onto one instant and averaged into one fix.
// That is the "a height at no particular place" error the windowing exists to
// prevent, reintroduced by the guard meant to protect it.
//
// An hour clears the FIFO at its slowest rate with room to spare, while a true
// base mismatch (epoch nanoseconds where boot nanoseconds were expected) lands
// decades out and is still caught. A reading from the future cannot be anything
// but a bad conversion, so the forward bound stays tight.
private const val MAX_EVENT_AGE_MS = 3_600_000L
private const val FUTURE_SLOP_MS = 2_000L

/**
 * Holds the pressure sensor open for the length of a ride.
 *
 * `expo-sensors` cannot do this, and the reason is one hook:
 * `SensorProxy.kt` registers `OnActivityEntersBackground { onHostPause() }`,
 * which calls `stopObserving()` and unregisters the listener. Pressing the
 * power button backgrounds the activity, so the barometer dies 11-19 seconds
 * into a locked screen and the ride falls back to GPS altitude, which carries
 * 0.65m of error per 15m bucket against the barometer's 0.29m.
 *
 * That 11-19 seconds is itself the evidence for what this module does. A clean
 * stop at a repeatable delay is the signature of an explicit unregister. CPU
 * suspend starving a non-wake sensor would look intermittent instead. So the
 * cure is to register the listener against the process and never unregister it
 * on an activity callback, and there is no need to hold a wake lock -- which
 * would cost battery for the whole ride to fix a cause that is not there.
 *
 * Readings land in a ring buffer rather than being pushed to JavaScript as
 * events. Pushing 5Hz of events into a paused JavaScript context for a
 * twenty-minute screen-off stretch is 6,000 bridge crossings that nothing is
 * listening to. The background location task pulls the readings it wants for
 * each fix instead, once per invocation.
 */
internal object PressureRecorder : SensorEventListener {
  private val ring = PressureRing(RING_CAPACITY)

  private var manager: SensorManager? = null
  private var thread: HandlerThread? = null
  private var handler: Handler? = null

  private var registered = false
  private var wakeUp = false
  private var requestedIntervalMs = 0
  private var startedAtMs: Long? = null

  private var delivered = 0L
  private var dropped = 0L
  private var repaired = 0L

  @Synchronized
  fun start(context: Context, intervalMs: Int): Boolean {
    // The application context, not the activity's. A sensor listener that
    // outlives the activity on purpose must not hold a reference to it.
    val service =
      context.applicationContext.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        ?: return false

    // Prefer the wake-up variant where the device has one: it wakes the SoC to
    // deliver, which closes the one remaining way a locked screen could starve
    // the ring. Most phones only ship the non-wake pressure sensor, which keeps
    // delivering for as long as the CPU is up -- and with a location callback
    // firing every 1-4 seconds and writing to storage, the CPU does not get to
    // suspend for long. `getStatusAsync` reports which one was obtained so a
    // disappointing test ride can be told apart from a device limitation.
    val wake = service.getDefaultSensor(Sensor.TYPE_PRESSURE, true)
    val sensor = wake ?: service.getDefaultSensor(Sensor.TYPE_PRESSURE) ?: return false

    // Held only once there is a sensor to unregister later. Assigning it above,
    // before the availability check, left `manager` populated on a path that
    // returns false and never registers anything.
    manager = service

    val wanted = intervalMs.coerceIn(MIN_INTERVAL_MS, MAX_INTERVAL_MS)

    if (registered) {
      // Idempotent by design. The recovery path in `useTrackingSession` can
      // re-enter a tracking state without the ride ever having stopped, and a
      // second `registerListener` for the same listener silently replaces the
      // rate rather than failing, which would leave `requestedIntervalMs`
      // lying about what the sensor is doing.
      if (wanted == requestedIntervalMs) return true
      service.unregisterListener(this)
      registered = false
    } else {
      ring.clear()
      delivered = 0
      dropped = 0
      repaired = 0
      startedAtMs = System.currentTimeMillis()
    }

    if (thread == null) {
      // Delivery on a thread of our own rather than the main looper. The main
      // thread is exactly the one that stops being serviced promptly when the
      // app is backgrounded, and queueing sensor events behind the UI is how a
      // fix that should have had seven readings ends up with two.
      thread = HandlerThread("ride-barometer").also { it.start() }
      handler = Handler(thread!!.looper)
    }

    // `maxReportLatencyUs = 0` asks for no batching. A hardware FIFO would hold
    // readings and deliver them late, and since the consumer indexes by sample
    // time it gains nothing from a buffer it has to wait for -- it would just
    // systematically lose the most recent second, which is the second the
    // current fix wants.
    //
    // The period is passed through in microseconds. `expo-sensors` instead asks
    // for SENSOR_DELAY_NORMAL and then throttles in software with
    // `currentTime - lastUpdate > updateInterval`, a strict comparison that
    // drops readings arriving at exactly the requested spacing -- so a 200ms
    // request there has been yielding closer to 2.5Hz than 5Hz.
    val ok = service.registerListener(this, sensor, wanted * 1_000, 0, handler)

    if (ok) {
      registered = true
      wakeUp = wake != null
      requestedIntervalMs = wanted
    } else {
      stopThread()
    }
    return ok
  }

  @Synchronized
  fun stop(): Boolean {
    val wasRegistered = registered
    if (registered) {
      manager?.unregisterListener(this)
      registered = false
    }
    requestedIntervalMs = 0
    stopThread()
    // The ring is left alone. A stop can race the last invocation of the
    // location task, and clearing here would lose the readings belonging to the
    // final fix of the ride for nothing -- `start` clears instead.
    return wasRegistered
  }

  private fun stopThread() {
    thread?.quitSafely()
    thread = null
    handler = null
  }

  @Synchronized
  fun window(fromMs: Long, toMs: Long): DoubleArray = ring.window(fromMs, toMs)

  @Synchronized
  fun counters(): Map<String, Any?> = mapOf(
    "registered" to registered,
    "wakeUp" to wakeUp,
    "requestedIntervalMs" to requestedIntervalMs,
    "delivered" to delivered.toDouble(),
    "dropped" to dropped.toDouble(),
    "repaired" to repaired.toDouble(),
    "held" to ring.size,
    "startedAtMs" to startedAtMs?.toDouble(),
  )

  @Synchronized
  fun status(context: Context): Map<String, Any?> {
    val service =
      context.applicationContext.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
    val sensor = service?.getDefaultSensor(Sensor.TYPE_PRESSURE, true)
      ?: service?.getDefaultSensor(Sensor.TYPE_PRESSURE)
    return mapOf(
      "available" to (sensor != null),
      "wakeUp" to (sensor?.isWakeUpSensor ?: false),
      "name" to sensor?.name,
      "vendor" to sensor?.vendor,
      // Smallest change the sensor can report, in hPa. 0.01 hPa is about 8cm of
      // air, so a sensor coarser than that cannot resolve a kerb.
      "resolutionHpa" to sensor?.resolution?.toDouble(),
      "minDelayUs" to sensor?.minDelay,
      "maxDelayUs" to sensor?.maxDelay,
      // Zero means the sensor has no FIFO, so nothing survives a CPU suspend.
      "fifoMaxEventCount" to sensor?.fifoMaxEventCount,
      "powerMa" to sensor?.power?.toDouble(),
    )
  }

  @Synchronized
  override fun onSensorChanged(event: SensorEvent) {
    // `event.values` is reused by the framework, so the float is read out here
    // and the array is never retained.
    val raw = event.values.firstOrNull() ?: return
    if (!raw.isFinite()) {
      // A non-finite reading has nothing to contribute to a mean, and letting
      // one into the ring would poison every window that contains it. Counted
      // rather than silently discarded so a failing sensor is visible.
      dropped++
      return
    }
    ring.add(wallClockMsFor(event.timestamp), raw.toDouble())
    delivered++
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

  /**
   * `SensorEvent.timestamp` is specified as nanoseconds since boot, the same
   * base as `SystemClock.elapsedRealtimeNanos()`. Real devices have violated
   * that for years: some report nanoseconds since the epoch, some a base that
   * drifts against both. Since the consumer compares these against
   * `Location.getTime()`, which is wall clock, the conversion has to happen
   * somewhere, and getting it wrong does not throw -- it produces readings that
   * silently match no fix, which looks exactly like a sensor that stopped.
   *
   * So the conversion is bounded, and a reading that lands outside the bounds
   * is stamped with the current time and counted. That degrades to "the newest
   * readings", which is what the old code did for every reading, rather than to
   * nothing at all.
   */
  private fun wallClockMsFor(eventTimestampNs: Long): Long {
    val nowWallMs = System.currentTimeMillis()
    val eventElapsedMs = eventTimestampNs / 1_000_000L
    val candidate = nowWallMs - (SystemClock.elapsedRealtime() - eventElapsedMs)
    if (candidate > nowWallMs + FUTURE_SLOP_MS || candidate < nowWallMs - MAX_EVENT_AGE_MS) {
      repaired++
      return nowWallMs
    }
    return candidate
  }
}

class RideBarometerModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("RideBarometer")

    AsyncFunction<Map<String, Any?>>("getStatusAsync") {
      PressureRecorder.status(context)
    }

    AsyncFunction<Boolean, Int>("startAsync") { intervalMs: Int ->
      PressureRecorder.start(context, intervalMs)
    }

    AsyncFunction<Boolean>("stopAsync") {
      PressureRecorder.stop()
    }

    AsyncFunction<DoubleArray, Double, Double>("readWindowAsync") { fromMs: Double, toMs: Double ->
      PressureRecorder.window(fromMs.toLong(), toMs.toLong())
    }

    AsyncFunction<Map<String, Any?>>("getCountersAsync") {
      PressureRecorder.counters()
    }

    // THERE IS DELIBERATELY NO OnActivityEntersBackground HOOK HERE, and that
    // omission is the entire feature. `expo-sensors` has one, it calls
    // `stopObserving()`, and it is why the barometer dies when the screen
    // locks. Adding one here to be tidy would undo the module.
    //
    // `OnDestroy` does stop the sensor, and should: it fires when the module
    // registry goes away, and at that point nothing can drain the ring, so
    // leaving the sensor registered would burn battery to fill a buffer no one
    // reads. A ride that survives a JavaScript teardown comes back through
    // `startAsync` on the recovery path.
    OnDestroy {
      PressureRecorder.stop()
    }
  }
}
