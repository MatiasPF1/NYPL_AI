import { MapDemo } from "@/components/Map_Demo";

export const metadata = {
  title: "Two routes · SafeNYC",
  description:
    "The shortest walk against the risk-weighted one, drawn from NYC crash data.",
};

/**
 * Public on purpose: this is the demo, and putting a magic-link inbox round
 * trip in front of it would make it unshowable. Move it under /app when the
 * saved-routes flow lands.
 */
export default function MapPage() {
  return <MapDemo />;
}
