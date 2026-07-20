import { useSyncExternalStore } from "react";
import {
  getMobileSessionIdentity,
  subscribeToMobileSessionIdentity,
} from "../services/authSession";

export function useMobileSessionIdentity() {
  return useSyncExternalStore(
    subscribeToMobileSessionIdentity,
    getMobileSessionIdentity,
    getMobileSessionIdentity,
  );
}
