import { useWindowDimensions } from "react-native";

export function useResponsiveFlags() {
  const { width, height } = useWindowDimensions();

  return {
    isCompactScreen: width < 390,
    isVeryCompactScreen: width < 360,
    isShortScreen: height < 760,
  };
}
