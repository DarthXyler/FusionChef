export type ImportedRecipePhotoSource = "Camera" | "Photo Library";

export type ImportedRecipePhoto = {
  uri: string;
  width: number;
  height: number;
  aspectRatio: number;
  sourceLabel: ImportedRecipePhotoSource;
  imageDataUrl?: string;
};
