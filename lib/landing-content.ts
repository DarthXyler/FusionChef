/**
 * Content for the 2026 redesigned landing page (app/page.tsx).
 * All fusion-dish images are placeholders in /public/landing/fusion/ —
 * see FUSION-IMAGE-PROMPTS.md for the exact AI prompts and sizes.
 */

import { ENTITLEMENT_SUMMARY, STORE_PURCHASE_SUMMARY } from "@/lib/public-site-content";

export const howItWorksSteps = [
  {
    title: "Add a recipe",
    body: "Type it, paste it, or snap a photo of grandma's recipe card. Any starting point works.",
    image: "/landing/fusion/step-1-add-recipe.jpg",
    imageAlt: "A homemade spaghetti bolognese next to a handwritten recipe card",
  },
  {
    title: "Pick a cuisine to fuse",
    body: "Chinese, Korean, Mexican, Thai... pick the flavor world you want to crash into your dish.",
    image: "/landing/fusion/step-2-pick-cuisine.jpg",
    imageAlt: "Bowls of world-cuisine spices and ingredients arranged in a circle",
  },
  {
    title: "AI creates the mashup",
    body: "Your fusion recipe appears on screen: full steps, smart ingredient swaps, and a shopping list.",
    image: "/landing/fusion/step-3-ai-mashup.jpg",
    imageAlt: "Freshly plated Spaghetti Sichuan Bolognese with chili oil and cilantro",
  },
  {
    title: "Cook it. Save it or not",
    body: "Love it? Keep it in your private cookbook. Not your thing? Reroll for a different twist.",
    image: "/landing/fusion/step-4-cook-save.jpg",
    imageAlt: "A finished fusion pasta dish beside a phone showing the saved recipe",
  },
] as const;

export const fusionFeatures = [
  {
    title: "Fusion cuisine",
    body: "Start with a familiar recipe and smash it into a whole new cuisine, while keeping the result genuinely cookable.",
    image: "/landing/fusion/feature-cuisine-fusion.jpg",
    imageAlt: "Sushi burrito sliced open showing Korean bulgogi, kimchi, and rice layers",
    dish: "Bulgogi Kimchi Sushi Burrito",
  },
  {
    title: "Photo import",
    body: "Snap any recipe: a cookbook page, a screenshot, a food image and use it as your fusion starting point.",
    image: "/landing/fusion/feature-photo-import.jpg",
    imageAlt: "Ramen Carbonara: ramen noodles in carbonara cream with crispy guanciale",
    dish: "Ramen Carbonara",
  },
  {
    title: "Private cookbook",
    body: "Your wildest successful experiments live in a cookbook that's yours alone. No feeds, no followers, just flavor.",
    image: "/landing/fusion/feature-cookbook.jpg",
    imageAlt: "Falafel shawarma bowl topped with Mexican street-corn and lime crema",
    dish: "Falafel Shawarma Street-Corn Bowl",
  },
  {
    title: "Rerolls with credits",
    body: "Not quite right? Reroll for another version. Signed-in users get one free fusion and one free reroll daily; after that, fusion costs 3 credits and reroll costs 1.",
    image: "/landing/fusion/feature-credits.jpg",
    imageAlt: "Tacos al pastor fused with Indian butter chicken on naan crisps",
    dish: "Butter Chicken Tacos al Pastor",
  },
] as const;

export const homeFaqItems = [
  {
    id: "home-what-is",
    question: "What is Flavor Fusion Chef?",
    answer:
      "A mobile cooking app that turns a base recipe into a practical fusion recipe: pick a cuisine, spice level, and dietary preferences, and the AI builds a cookable mashup.",
  },
  {
    id: "home-fusion-quality",
    question: "Will the fusion recipes actually taste good?",
    answer:
      "That's the whole point. Recipes keep real cooking technique intact. The fusion changes flavor direction, not feasibility. And if a result isn't your thing, reroll it for a different twist.",
  },
  {
    id: "home-credits",
    question: "How do credits work?",
    answer: `${ENTITLEMENT_SUMMARY} ${STORE_PURCHASE_SUMMARY}`,
  },
  {
    id: "home-photo-import",
    question: "Can I import a recipe photo?",
    answer:
      "Yes. Snap or upload a recipe photo and the app turns it into structured recipe input before creating your fusion version.",
  },
  {
    id: "home-cookbook",
    question: "Can I save recipes?",
    answer:
      "Yes. Recipes you choose to keep are saved to your private mobile cookbook so you can revisit them later.",
  },
  {
    id: "home-purchases",
    question: "Where are purchases handled?",
    answer:
      "Purchases are processed by the App Store on iOS or Google Play on Android. Refund requests are handled by the store where the purchase was made under that store's policies.",
  },
] as const;

/**
 * PLACEHOLDER TESTIMONIALS — intentionally NOT rendered anywhere yet.
 * When real App Store reviews come in, swap these out and wire a
 * testimonials section into app/page.tsx between Features and Pricing.
 */
export const placeholderTestimonials = [
  {
    name: "Maya R.",
    detail: "Home cook, Austin",
    quote:
      "I fed it my mom's enchilada recipe and asked for Thai. The lemongrass-poblano version is now requested at every family dinner.",
    rating: 5,
  },
  {
    name: "Daniel K.",
    detail: "Meal-prep enthusiast",
    quote:
      "The ramen carbonara it generated sounded illegal. It was incredible. The shopping list feature alone is worth the credits.",
    rating: 5,
  },
  {
    name: "Priya S.",
    detail: "Weeknight experimenter",
    quote:
      "Photo import is magic — I snapped a recipe card from a charity cookbook and had a Korean-fused version in under a minute.",
    rating: 4,
  },
  {
    name: "Tomás L.",
    detail: "Taco purist (reformed)",
    quote:
      "Came in skeptical about butter chicken al pastor. Left a believer. The rerolls let me dial the spice exactly where I wanted.",
    rating: 5,
  },
] as const;
