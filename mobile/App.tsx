import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AppState } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { MobileCookbookProvider } from "./src/context/mobileCookbook";
import type {
  CookbookStackParamList,
  HomeStackParamList,
  RootTabParamList,
} from "./src/navigation/types";
import { HomeScreen } from "./src/screens/HomeScreen";
import { DashboardHomeScreen } from "./src/screens/DashboardHomeScreen";
import { RecentFusionsScreen } from "./src/screens/RecentFusionsScreen";
import { RecipeWorkspaceScreen } from "./src/screens/RecipeWorkspaceScreen";
import { CookbookListScreen } from "./src/screens/CookbookListScreen";
import { CookbookDetailScreen } from "./src/screens/CookbookDetailScreen";
import { ProfileScreen } from "./src/screens/ProfileScreen";
import { fetchMonetizationAccountSnapshot } from "./src/services/monetization";

const HomeStack = createNativeStackNavigator<HomeStackParamList>();
const CookbookStack = createNativeStackNavigator<CookbookStackParamList>();
const RootTab = createBottomTabNavigator<RootTabParamList>();

function AccountSnapshotRefreshBridge() {
  useEffect(() => {
    const refreshAccountSnapshot = () => {
      void fetchMonetizationAccountSnapshot({ forceRefresh: true }).catch(() => {
        // Normal screens show their own error states when the account snapshot is needed.
      });
    };

    refreshAccountSnapshot();
    const interval = setInterval(refreshAccountSnapshot, 15 * 60 * 1000);
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        refreshAccountSnapshot();
      }
    });

    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, []);

  return null;
}

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
      <HomeStack.Screen
        name="DashboardHome"
        component={DashboardHomeScreen}
        options={{ headerShown: false }}
      />
      <HomeStack.Screen
        name="RecentFusions"
        component={RecentFusionsScreen}
        options={{ headerShown: false }}
      />
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

function CreateStackNavigator() {
  return (
    <HomeStack.Navigator>
      <HomeStack.Screen name="CreateFusion" component={HomeScreen} options={{ headerShown: false }} />
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
  return (
    <SafeAreaProvider>
      <MobileCookbookProvider>
        <NavigationContainer>
          <AccountSnapshotRefreshBridge />
          <StatusBar style="dark" />
          <RootTab.Navigator
            screenOptions={{
              headerShown: false,
              tabBarActiveTintColor: "#10b981",
              tabBarInactiveTintColor: "#6b7280",
              tabBarLabelStyle: {
                fontSize: 11,
                fontWeight: "700",
              },
              tabBarStyle: {
                backgroundColor: "#ffffff",
                borderTopColor: "#d1fae5",
                height: 70,
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
                    screen: "DashboardHome",
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
            <RootTab.Screen
              name="Create"
              component={CreateStackNavigator}
              listeners={({ navigation }) => ({
                tabPress: (event) => {
                  event.preventDefault();
                  navigation.navigate("Create", {
                    screen: "CreateFusion",
                    params: { resetToken: String(Date.now()) },
                  });
                },
              })}
              options={{
                tabBarLabel: "Create",
                tabBarIcon: ({ color, size }) => (
                  <MaterialIcons color={color} name="add-box" size={size} />
                ),
              }}
            />
            <RootTab.Screen
              name="Profile"
              component={ProfileScreen}
              options={{
                tabBarLabel: "Profile",
                tabBarIcon: ({ color, size }) => (
                  <MaterialIcons color={color} name="person-outline" size={size} />
                ),
              }}
            />
          </RootTab.Navigator>
        </NavigationContainer>
      </MobileCookbookProvider>
    </SafeAreaProvider>
  );
}
