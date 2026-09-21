import { redirect } from "next/navigation";
import { FileSpreadsheet } from "lucide-react";
import { safeNext } from "@/lib/auth-shared";
import { googleConfigured } from "@/lib/google";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  denied: "Sign-in was cancelled. You can try again, or continue with the sample data.",
  invalid: "That sign-in link wasn't valid or has expired. Please try again.",
  unverified: "Google says that email address isn't verified, so it can't be used to sign in.",
  failed: "Something went wrong talking to Google. Please try again.",
  not_configured: "Google sign-in isn't set up on this server yet.",
};

function GoogleLogo() {
  return (
    <svg viewBox="0 0 48 48" className="h-5 w-5" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export default async function Page({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const params = await searchParams;
  const next = safeNext(params.next); // the page they were trying to reach
  if (await getCurrentUser()) redirect(next); // already signed in

  const { error } = params;
  const message = error && Object.hasOwn(ERRORS, error) ? ERRORS[error] : null;
  const configured = googleConfigured();

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F8FAFC] p-6">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-500 text-white shadow-sm">
            <FileSpreadsheet className="h-5 w-5" />
          </div>
          <span className="text-xl font-bold tracking-tight text-slate-900">MailScan</span>
        </div>

        <h1 className="mt-6 text-2xl font-bold tracking-tight text-slate-900">Welcome</h1>
        <p className="mt-1 text-sm text-slate-500">
          Sign in to bring in your own Gmail, or explore with the sample data.
        </p>

        {message && (
          <p role="alert" className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {message}
          </p>
        )}

        <div className="mt-6 space-y-3">
          {/* A plain <a>, not <Link>: this is an API redirect, and Link would prefetch it. */}
          {configured ? (
            <a
              href={next === "/" ? "/api/auth/google" : `/api/auth/google?next=${encodeURIComponent(next)}`}
              className="flex h-11 w-full items-center justify-center gap-3 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <GoogleLogo />
              Sign in with Google
            </a>
          ) : (
            <button
              type="button"
              disabled
              className="flex h-11 w-full cursor-not-allowed items-center justify-center gap-3 rounded-lg border border-slate-200 bg-slate-50 text-sm font-semibold text-slate-400"
            >
              <GoogleLogo />
              Sign in with Google (not set up)
            </button>
          )}

          <div className="flex items-center gap-3 text-xs font-medium text-slate-400">
            <span className="h-px flex-1 bg-slate-200" />
            or
            <span className="h-px flex-1 bg-slate-200" />
          </div>

          {/* A POST form: it remembers the choice (guest cookie) so we stop redirecting here. */}
          <form method="post" action="/api/auth/guest">
            <input type="hidden" name="next" value={next} />
            <button
              type="submit"
              className="flex h-11 w-full items-center justify-center rounded-lg bg-red-500 text-sm font-semibold text-white shadow-sm hover:bg-red-600"
            >
              Continue with sample data
            </button>
          </form>
        </div>

        <p className="mt-6 text-xs leading-relaxed text-slate-500">
          Signing in asks Google for <strong className="font-semibold text-slate-700">read-only</strong> access to your
          Gmail, so Averis can classify your own emails. The sample data is a shared set of demo emails that everyone
          can see, with no sign-in needed.
        </p>
      </div>
    </div>
  );
}
