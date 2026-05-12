import { Image, Text, View } from "react-native";
import { styles } from "../styles/appStyles";
import brandChefLogo from "../../assets/brand-chef-logo.png";

type BrandHeaderProps = {
  compact?: boolean;
};

export function BrandHeader({ compact = false }: BrandHeaderProps) {
  return (
    <View style={[styles.brandHeader, compact && styles.brandHeaderCompact]}>
      <Image
        accessibilityIgnoresInvertColors
        source={brandChefLogo}
        style={[styles.brandHeaderLogo, compact && styles.brandHeaderLogoCompact]}
      />
      <Text style={[styles.brandHeaderText, compact && styles.brandHeaderTextCompact]}>
        Flavor <Text style={styles.brandHeaderAccent}>Fusion</Text> Chef
      </Text>
    </View>
  );
}
