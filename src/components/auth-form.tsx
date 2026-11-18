"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { AuthFormState } from "@/app/actions/auth";

type AuthFormProps = {
  title: string;
  action: (state: AuthFormState, formData: FormData) => Promise<AuthFormState>;
  submitLabel: string;
  passwordAutoComplete: "current-password" | "new-password";
  altText: string;
  altHref: string;
  altLabel: string;
};

export function AuthForm({
  title,
  action,
  submitLabel,
  passwordAutoComplete,
  altText,
  altHref,
  altLabel,
}: AuthFormProps) {
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <main className="auth">
      <h1>{title}</h1>
      <form action={formAction} className="auth-form">
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={passwordAutoComplete}
          required
        />
        {state?.error && (
          <p role="alert" className="auth-error">
            {state.error}
          </p>
        )}
        <button type="submit" disabled={pending}>
          {pending ? "Please wait..." : submitLabel}
        </button>
      </form>
      <p>
        {altText} <Link href={altHref}>{altLabel}</Link>
      </p>
    </main>
  );
}
