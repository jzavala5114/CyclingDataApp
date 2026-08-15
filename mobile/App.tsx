import { StatusBar } from "expo-status-bar";
// Registers the background location task with TaskManager. This has to happen
// at module scope during app startup -- Android can relaunch the JS context
// to deliver a background fix, and the task must already be defined by then.
import "./src/services/backgroundLocationTask";
import { MapScreen } from "./src/screens/MapScreen";

export default function App() {
  return (
    <>
      <MapScreen />
      <StatusBar style="auto" />
    </>
  );
}
