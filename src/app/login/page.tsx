import { login } from "@/app/actions/auth";
import { AuthForm } from "@/components/auth-form";

export default function LoginPage() {
  return (
    <AuthForm
      title="Log in"
      action={login}
      submitLabel="Log in"
      passwordAutoComplete="current-password"
      altText="No account yet?"
      altHref="/signup"
      altLabel="Sign up"
    />
  );
}
