import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { Pacifico_400Regular } from "@expo-google-fonts/pacifico";
import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useFonts } from "expo-font";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { MobileCookbookProvider } from "./src/context/mobileCookbook";
import type {
  CookbookStackParamList,
  HomeStackParamList,
  RootTabParamList,
} from "./src/navigation/types";
import { HomeScreen } from "./src/screens/HomeScreen";
import { RecipeWorkspaceScreen } from "./src/screens/RecipeWorkspaceScreen";
import { CookbookListScreen } from "./src/screens/CookbookListScreen";
import { CookbookDetailScreen } from "./src/screens/CookbookDetailScreen";
import { styles } from "./src/styles/appStyles";

const HomeStack = createNativeStackNavigator<HomeStackParamList>();
const CookbookStack = createNativeStackNavigator<CookbookStackParamList>();
const RootTab = createBottomTabNavigator<RootTabParamList>();

function CookbookStackNavigator() {
  return (
    <CookbookStack.Navigator>
      <CookbookStack.Screen
        name="CookbookList"
        component={CookbookListScreen}
        options={{ headerShown: false }}
      />
      <CookbookStack.Screen
        name="CookbookDetail"
        component={CookbookDetailScreen}
        options={{ headerShown: false }}
      />
    </CookbookStack.Navigator>
  );
}

function HomeStackNavigator() {
  return (
    <HomeStack.Navigator>
      <HomeStack.Screen name="Home" component={HomeScreen} options={{ headerShown: false }} />
      <HomeStack.Screen
        name="RecipeWorkspace"
        component={RecipeWorkspaceScreen}
        options={{
          headerShown: false,
          gestureEnabled: false,
        }}
      />
    </HomeStack.Navigator>
  );
}

export default function App() {
  const [fontsLoaded] = useFonts({
    Pacifico_400Regular,
  });

  if (!fontsLoaded) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.safeArea} />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <MobileCookbookProvider>
        <NavigationContainer>
          <StatusBar style="dark" />
          <RootTab.Navigator
            screenOptions={{
              headerShown: false,
              tabBarActiveTintColor: "#10b981",
              tabBarInactiveTintColor: "#6b7280",
              tabBarLabelStyle: {
                fontSize: 12,
                fontWeight: "700",
              },
              tabBarStyle: {
                backgroundColor: "#ffffff",
                borderTopColor: "#d1fae5",
                height: 68,
                paddingBottom: 8,
                paddingTop: 8,
              },
            }}
          >
            <RootTab.Screen
              name="Explore"
              component={HomeStackNavigator}
              listeners={({ navigation }) => ({
                tabPress: (event) => {
                  event.preventDefault();
                  navigation.navigate("Explore", {
                    screen: "Home",
                    params: { resetToken: String(Date.now()) },
                  });
                },
              })}
              options={{
                tabBarLabel: "Home",
                tabBarIcon: ({ color, size, focused }) => (
                  <MaterialIcons
                    color={color}
                    name={focused ? "home" : "home-filled"}
                    size={size}
                  />
                ),
              }}
            />
            <RootTab.Screen
              name="Cookbook"
              component={CookbookStackNavigator}
              options={{
                tabBarLabel: "Cookbook",
                tabBarIcon: ({ color, size }) => (
                  <MaterialCommunityIcons color={color} name="chef-hat" size={size} />
                ),
              }}
            />
          </RootTab.Navigator>
        </NavigationContainer>
      </MobileCookbookProvider>
    </SafeAreaProvider>
  );
}
