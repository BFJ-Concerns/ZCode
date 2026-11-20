import { z } from "zod";
import { toToolJsonSchema } from "../../tools/json-schema.js";

export const ImageSearchInputSchema = z.object({ query: z.string().min(2) }).strict();
export const ImageSearchOutputSchema = z.object({
  query: z.string(),
  results: z.array(
    z.object({
      url: z.string(),
      imageUrl: z.string(),
      title: z.string().optional(),
    }),
  ),
});

export const ImageSearchInputJsonSchema = toToolJsonSchema(ImageSearchInputSchema);
export const ImageSearchOutputJsonSchema = toToolJsonSchema(ImageSearchOutputSchema);
