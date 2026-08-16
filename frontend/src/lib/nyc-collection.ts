import type { CollectionItem } from "@/components/ui/collection-surfer";

/**
 * The three boroughs SafeNYC covers first, four views each.
 *
 * Every URL below was fetched and inspected before being listed — Unsplash
 * IDs are easy to typo into a photo of somewhere else entirely, and a card
 * labelled QUEENS showing San Francisco is worse than no card at all.
 */
export const NYC_COLLECTION: CollectionItem[] = [
  // ---- Manhattan ----
  {
    id: 1,
    subtitle: "Manhattan",
    title: "Times Square",
    image:
      "https://images.unsplash.com/photo-1496442226666-8d4d0e62e6e9?w=800&q=80",
  },
  {
    id: 2,
    subtitle: "Manhattan",
    title: "Midtown",
    image:
      "https://images.unsplash.com/photo-1485871981521-5b1fd3805eee?w=800&q=80",
  },
  {
    id: 3,
    subtitle: "Manhattan",
    title: "Lower Manhattan",
    image:
      "https://images.unsplash.com/photo-1518235506717-e1ed3306a89b?w=800&q=80",
  },
  {
    id: 4,
    subtitle: "Manhattan",
    title: "Central Park",
    image:
      "https://images.unsplash.com/photo-1563385509983-1df24409dc4e?w=800&q=80",
  },

  // ---- Brooklyn ----
  {
    id: 5,
    subtitle: "Brooklyn",
    title: "Dumbo",
    image:
      "https://images.unsplash.com/photo-1573261658953-8b29e144d1af?w=800&q=80",
  },
  {
    id: 6,
    subtitle: "Brooklyn",
    title: "Brownstone streets",
    image:
      "https://images.unsplash.com/photo-1667628062458-2fb34c8a42e4?w=800&q=80",
  },
  {
    id: 7,
    subtitle: "Brooklyn",
    title: "Rooftops",
    image:
      "https://images.unsplash.com/photo-1544692253-77d2d110a8de?w=800&q=80",
  },
  {
    id: 8,
    subtitle: "Brooklyn",
    title: "Brooklyn Bridge",
    image:
      "https://images.unsplash.com/photo-1550909407-4144f2e6b459?w=800&q=80",
  },

  // ---- Queens ----
  {
    id: 9,
    subtitle: "Queens",
    title: "The 7 train",
    image:
      "https://images.unsplash.com/photo-1522482178516-7a04ae0dce7a?w=800&q=80",
  },
  {
    id: 10,
    subtitle: "Queens",
    title: "Unisphere",
    image:
      "https://images.unsplash.com/photo-1609194243294-41e8564646c2?w=800&q=80",
  },
  {
    id: 11,
    subtitle: "Queens",
    title: "Long Island City",
    image:
      "https://images.unsplash.com/photo-1628371840169-e0a786b6b3ff?w=800&q=80",
  },
  {
    id: 12,
    subtitle: "Queens",
    title: "Ravenswood",
    image:
      "https://images.unsplash.com/photo-1550860759-22105316bc44?w=800&q=80",
  },
];
