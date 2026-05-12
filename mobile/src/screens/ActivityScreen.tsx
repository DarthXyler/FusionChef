import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BrandHeader } from "../components/BrandHeader";
import { styles } from "../styles/appStyles";

export function ActivityScreen() {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.screen}>
        <View style={styles.profileContent}>
          <View style={styles.profileTopBar}>
            <BrandHeader compact />
          </View>
          <View style={styles.profileHeroCard}>
            <View style={styles.activityEmptyIcon}>
              <MaterialIcons color="#047857" name="timeline" size={30} />
            </View>
            <Text style={styles.profileTitle}>Activity</Text>
            <Text style={styles.profileSubtitle}>
              Recent generations, credit activity, and cookbook changes will appear here as Mobile
              2.0 grows.
            </Text>
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}
