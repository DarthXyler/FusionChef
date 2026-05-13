export const SUPPORT_EMAIL = "darthxyler@gmail.com";

export const fallbackCreditPacks = [
  {
    name: "Starter Pack",
    credits: 20,
    price: "$2.99",
    productId: "com.flavorfusion.credits.20",
    description: "A light pack for trying a few fusion ideas and saving your favorites.",
    featured: false,
  },
  {
    name: "Chef Pack",
    credits: 50,
    price: "$6.99",
    productId: "com.flavorfusion.credits.50",
    description: "A flexible pack for regular recipe experiments and rerolls.",
    featured: true,
  },
  {
    name: "Pro Pack",
    credits: 120,
    price: "$14.99",
    productId: "com.flavorfusion.credits.120",
    description: "Best for frequent cooks who want a larger idea bank ready to go.",
    featured: false,
  },
] as const;

export const faqItems = [
  {
    id: "what-is-flavor-fusion-chef",
    question: "What is Flavor Fusion Chef?",
    answer:
      "Flavor Fusion Chef is a mobile cooking app that helps you turn a base recipe into a practical fusion recipe with cuisine, spice, and dietary preferences.",
  },
  {
    id: "credits-work",
    question: "How do credits work?",
    answer:
      "Credits are one-time consumable items used for recipe generation and rerolls. They are not a subscription, and they do not renew automatically.",
  },
  {
    id: "cookbook-saves",
    question: "Can I save recipes?",
    answer:
      "Yes. Recipes you choose to keep can be saved to your mobile cookbook so you can revisit them later.",
  },
  {
    id: "recipe-photo-import",
    question: "Can I import a recipe photo?",
    answer:
      "Yes. The mobile app can help turn a recipe photo into structured recipe input before creating a fusion version.",
  },
  {
    id: "recipe-generation-help",
    question: "What if a generated recipe looks wrong or unexpected?",
    answer:
      "Check the base recipe wording, cuisine choice, meal type, and dietary preferences first. If the result still looks wrong, contact support with the recipe details.",
  },
  {
    id: "purchases-handled",
    question: "Where are purchases handled?",
    answer:
      "iOS purchases are handled by Apple through the App Store purchase flow. Refund requests for Apple purchases are handled under Apple's policies.",
  },
] as const;

export const supportFaqItems = [
  {
    supportKey: "recipe-generation",
    id: "support-recipe-generation",
    question: "Recipe generation support",
    answer:
      "Use this guide when recipe generation gives an unexpected result. First, retry with a clear base dish name or recipe text, confirm the meal type matches the dish, and check whether the selected fusion cuisine and dietary style are too restrictive together. If you contact support, include the base recipe, meal type, fusion cuisine, dietary style, spice level, the generated recipe title, and a screenshot of the result. This helps us compare the exact input with the output.",
  },
  {
    supportKey: "recipe-photo-import",
    id: "support-recipe-photo-import",
    question: "Recipe photo import support",
    answer:
      "Use this guide when importing a recipe photo does not work as expected. Make sure the photo is clear, well lit, and includes the full recipe text. If extraction looks incomplete, try cropping out unrelated content and refresh the extracted text before generating. If you contact support, include whether the image came from camera or library, whether text extraction started, any error message you saw, your device model, and a screenshot of the photo/import screen.",
  },
] as const;

export const featureCards = [
  {
    title: "Cuisine fusion",
    body: "Start with a familiar recipe and explore a new cuisine direction while keeping the result cookable.",
  },
  {
    title: "Photo import",
    body: "Bring in a recipe image from your phone and use it as a starting point for a cleaner mobile workflow.",
  },
  {
    title: "Private cookbook",
    body: "Save the recipes that work for you in a cheerful cookbook built around your own experiments.",
  },
  {
    title: "Rerolls with credits",
    body: "Try another version when you want a different twist, ingredient swap, or flavor balance.",
  },
] as const;

export const legalLastUpdated = "May 2, 2026";
