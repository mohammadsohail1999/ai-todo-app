"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type AuthFormState = { error: string } | null;

function readCredentials(formData: FormData) {
  const email = formData.get("email");
  const password = formData.get("password");

  if (typeof email !== "string" || typeof password !== "string") return null;
  if (!email.trim() || !password) return null;

  return { email: email.trim(), password };
}

export async function login(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const credentials = readCredentials(formData);
  if (!credentials) return { error: "Enter your email and password." };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(credentials);
  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  redirect("/");
}

export async function signup(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const credentials = readCredentials(formData);
  if (!credentials) return { error: "Enter your email and password." };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp(credentials);
  if (error) return { error: error.message };

  // Supabase returns no session while "Confirm email" is on in the project's settings.
  if (!data.session) {
    return {
      error:
        "Signup didn't start a session. Turn off email confirmation in the Supabase project.",
    };
  }

  revalidatePath("/", "layout");
  redirect("/");
}

export async function logout() {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();
  if (error) console.error("Sign out failed:", error);

  revalidatePath("/", "layout");
  redirect("/login");
}
