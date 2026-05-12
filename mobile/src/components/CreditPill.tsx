import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { Pressable, Text } from "react-native";
import { styles } from "../styles/appStyles";

type CreditPillProps = {
  credits: number;
  onPress?: () => void;
};

export function CreditPill({ credits, onPress }: CreditPillProps) {
  return (
    <Pressable
      accessibilityLabel="Buy credits"
      accessibilityRole="button"
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.profileCreditsPill,
        pressed && styles.profileRowPressed,
      ]}
    >
      <MaterialCommunityIcons color="#047857" name="database" size={16} />
      <Text style={styles.profileCreditsText}>{credits}</Text>
    </Pressable>
  );
}
