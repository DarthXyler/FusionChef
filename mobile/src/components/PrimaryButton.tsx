import { Pressable, StyleSheet, Text } from "react-native";

type PrimaryButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
};

export function PrimaryButton({ label, onPress, disabled = false }: PrimaryButtonProps) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        (pressed || disabled) && styles.buttonPressed,
      ]}
    >
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    backgroundColor: "#10b981",
    borderRadius: 16,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  buttonPressed: {
    opacity: 0.86,
  },
  label: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "700",
  },
});
