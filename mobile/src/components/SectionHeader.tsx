import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Text, View } from "react-native";
import { styles } from "../styles/appStyles";

export function SectionHeader({
  iconName,
  title,
}: {
  iconName: React.ComponentProps<typeof MaterialIcons>["name"];
  title: string;
}) {
  return (
    <View style={styles.sectionHeaderRow}>
      <MaterialIcons color="#065f46" name={iconName} size={18} />
      <Text style={styles.sectionHeaderTitle}>{title}</Text>
    </View>
  );
}
