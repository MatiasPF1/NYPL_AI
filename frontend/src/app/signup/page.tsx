import { AuthScreen } from "@/components/Login_Page";

export const metadata = {
  title: "Create account · SafeNYC",
};

export default function Page() {
  return <AuthScreen mode="signup" />;
}
