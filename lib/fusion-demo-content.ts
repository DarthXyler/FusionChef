/**
 * Content for the interactive "Fusion Demo" section on the landing page.
 * Three base dishes × three cuisines = nine pre-rendered fusion results,
 * keyed "<baseId>-<cuisineId>".
 */

export type FusionDemoBase = {
  id: string;
  name: string;
  image: string;
};

export type FusionDemoCuisine = {
  id: string;
  name: string;
  flag: string;
};

export type FusionDemoResult = {
  name: string;
  image: string;
};

export const fusionDemoBases: FusionDemoBase[] = [
  {
    id: "bolognese",
    name: "Spaghetti Bolognese",
    image: "/landing/fusion-demo/base-bolognese.jpg",
  },
  {
    id: "moussaka",
    name: "Moussaka",
    image: "/landing/fusion-demo/base-moussaka.jpg",
  },
  {
    id: "pizza",
    name: "Margherita Pizza",
    image: "/landing/fusion-demo/base-pizza.jpg",
  },
];

export const fusionDemoCuisines: FusionDemoCuisine[] = [
  {
    id: "chinese",
    name: "Chinese",
    flag: "/landing/fusion-demo/flags/cn.svg",
  },
  {
    id: "korean",
    name: "Korean",
    flag: "/landing/fusion-demo/flags/kr.svg",
  },
  {
    id: "mexican",
    name: "Mexican",
    flag: "/landing/fusion-demo/flags/mx.svg",
  },
];

export const fusionDemoResults: Record<string, FusionDemoResult> = {
  "bolognese-chinese": {
    name: "Sichuan Spaghetti Bolognese",
    image: "/landing/fusion-demo/fusion-bolognese-chinese.jpg",
  },
  "bolognese-korean": {
    name: "Gochujang Bulgogi Bolognese",
    image: "/landing/fusion-demo/fusion-bolognese-korean.jpg",
  },
  "bolognese-mexican": {
    name: "Chipotle Taco Bolognese",
    image: "/landing/fusion-demo/fusion-bolognese-mexican.jpg",
  },
  "moussaka-chinese": {
    name: "Mapo Tofu Moussaka",
    image: "/landing/fusion-demo/fusion-moussaka-chinese.jpg",
  },
  "moussaka-korean": {
    name: "Kimchi Bulgogi Moussaka",
    image: "/landing/fusion-demo/fusion-moussaka-korean.jpg",
  },
  "moussaka-mexican": {
    name: "Smoky Mole Moussaka",
    image: "/landing/fusion-demo/fusion-moussaka-mexican.jpg",
  },
  "pizza-chinese": {
    name: "Peking Duck Pizza",
    image: "/landing/fusion-demo/fusion-pizza-chinese.jpg",
  },
  "pizza-korean": {
    name: "Bulgogi Kimchi Pizza",
    image: "/landing/fusion-demo/fusion-pizza-korean.jpg",
  },
  "pizza-mexican": {
    name: "Al Pastor Pizza",
    image: "/landing/fusion-demo/fusion-pizza-mexican.jpg",
  },
};
