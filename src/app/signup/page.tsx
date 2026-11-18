import { signup } from "@/app/actions/auth";
import { AuthForm } from "@/components/auth-form";

export default function SignupPage() {
  return (
    <AuthForm
      title="Sign up"
      action={signup}
      submitLabel="Sign up"
      passwordAutoComplete="new-password"
      altText="Already have an account?"
      altHref="/login"
      altLabel="Log in"
    />
  );
}
