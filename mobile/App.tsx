import { StatusBar } from "expo-status-bar";
import { MapScreen } from "./src/screens/MapScreen";

export default function App() {
  return (
    <>
      <MapScreen />
      <StatusBar style="auto" />
    </>
  );
}
