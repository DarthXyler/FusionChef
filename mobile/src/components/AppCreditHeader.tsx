import { useNavigation, type NavigationProp } from "@react-navigation/native";
import { useEffect, useState } from "react";
import { View } from "react-native";
import type { RootTabParamList } from "../navigation/types";
import {
  fetchMonetizationAccountSnapshot,
  subscribeToMonetizationAccountSnapshot,
} from "../services/monetization";
import { styles } from "../styles/appStyles";
import { BrandHeader } from "./BrandHeader";
import { CreditPill } from "./CreditPill";

export function AppCreditHeader() {
  const navigation = useNavigation<NavigationProp<RootTabParamList>>();
  const [credits, setCredits] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void fetchMonetizationAccountSnapshot({ preferCache: true })
      .then((snapshot) => {
        if (!cancelled) {
          setCredits(snapshot.balance.availableCredits);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCredits(0);
        }
      });

    const unsubscribe = subscribeToMonetizationAccountSnapshot((snapshot) => {
      setCredits(snapshot.balance.availableCredits);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return (
    <View style={styles.profileTopBar}>
      <BrandHeader compact />
      <CreditPill
        credits={credits}
        onPress={() => {
          const rootNavigation = navigation.getParent<NavigationProp<RootTabParamList>>();
          (rootNavigation ?? navigation).navigate("Profile", {
            openCreditSheetToken: String(Date.now()),
          });
        }}
      />
    </View>
  );
}
