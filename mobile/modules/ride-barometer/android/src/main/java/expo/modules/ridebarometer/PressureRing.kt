package expo.modules.ridebarometer

/**
 * A fixed-size, overwrite-oldest store of timestamped pressure readings.
 *
 * The reason this exists rather than a running sum and count: the sum was fine
 * while the only consumer drained it once per GPS fix, because the fix interval
 * bounded the averaging window to 1-4 seconds. Once readings accumulate in
 * native code the drain and the sampling are separate events, and nothing
 * bounds the window any more. A mean over sixty seconds is a height at no
 * particular place -- at 5 m/s on a 5% grade that is a 15 metre error -- so the
 * consumer has to be able to pick the readings near a given fix, which means
 * keeping their times.
 *
 * NOT THREAD SAFE on purpose. `PressureRecorder` owns the only instance and
 * holds its own monitor across every call, so there is one lock rather than two
 * nested ones. Keeping this class free of synchronisation also keeps it a plain
 * data structure that can be exercised on its own.
 */
internal class PressureRing(private val capacity: Int) {
  init {
    require(capacity > 0) { "capacity must be positive, got $capacity" }
  }

  private val times = LongArray(capacity)
  private val pressures = DoubleArray(capacity)

  /**
   * Total readings ever written, not the number currently held. Kept as the
   * write cursor so that `size` and the read order fall out of one counter
   * instead of a separate head, tail and full flag, which is where ring buffers
   * usually go wrong.
   */
  private var written: Long = 0

  val size: Int
    get() = minOf(written, capacity.toLong()).toInt()

  fun add(atMs: Long, hPa: Double) {
    val index = (written % capacity).toInt()
    times[index] = atMs
    pressures[index] = hPa
    written++
  }

  /**
   * Readings sampled in `[fromMs, toMs]` inclusive, oldest first, as a flat
   * `[atMs, hPa, atMs, hPa, ...]`.
   *
   * Flat doubles rather than a list of objects for two reasons. A `DoubleArray`
   * is handed to JavaScript as a typed array without building one object per
   * reading, and a screen-off stretch can return hundreds of readings per task
   * invocation. It is also the return shape Expo's converter passes through
   * untouched, so there is no chance of a conversion failure at runtime on a
   * path that only runs on a phone.
   *
   * A wall-clock millisecond is about 1.8e12, well inside the range where a
   * double holds an integer exactly (2^53, about 9e15), so the `toDouble()`
   * below loses nothing. It looks lossy and is not.
   *
   * The scan is linear over at most `capacity` entries. Readings arrive in time
   * order so a binary search would work, but only until a repaired timestamp
   * breaks the ordering, and a 1024-entry scan costs less than the branch
   * needed to decide whether the search is still safe.
   */
  fun window(fromMs: Long, toMs: Long): DoubleArray {
    if (fromMs > toMs) return EMPTY

    val held = size
    val first = written - held
    var matched = 0
    for (cursor in first until written) {
      val at = times[(cursor % capacity).toInt()]
      if (at in fromMs..toMs) matched++
    }
    if (matched == 0) return EMPTY

    val out = DoubleArray(matched * 2)
    var write = 0
    for (cursor in first until written) {
      val index = (cursor % capacity).toInt()
      val at = times[index]
      if (at in fromMs..toMs) {
        out[write++] = at.toDouble()
        out[write++] = pressures[index]
      }
    }
    return out
  }

  /**
   * Forgets every reading. Called when a ride starts, so the first fix of a new
   * ride cannot average in pressure from where the phone was sitting an hour
   * ago. Deliberately NOT called when the sampling rate changes mid-ride, which
   * would throw away readings the next fix is about to use.
   */
  fun clear() {
    written = 0
  }

  private companion object {
    val EMPTY = DoubleArray(0)
  }
}
