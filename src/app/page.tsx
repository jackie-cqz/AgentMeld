import { AppShell } from "@/components/app-shell";
import { AuthGate } from "@/components/auth-gate";

export default function HomePage() {
  return (
    <AuthGate>
      <AppShell />
    </AuthGate>
  );
}
