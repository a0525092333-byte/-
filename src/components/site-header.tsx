import { Link } from "@tanstack/react-router";
import { site } from "@/content/site";

// Public header by default — NO auth wired. Most sites need nothing here.
// To add accounts: create a `/login` route rendering <AuthForm/>
// ("@/components/auth-form"), then add a Sign-in <Link to="/login"> below,
// gated by useAuth() ("@/hooks/use-auth"). Those modules + the
// "@/integrations/neon/auth" client ship ready — they're just not imported.
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-3">
        <Link to="/" className="font-semibold tracking-tight">
          {site.name}
        </Link>
        <nav className="flex items-center gap-3 text-sm">
          {site.nav.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="text-muted-foreground hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
