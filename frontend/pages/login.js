'use client';

import { useEffect, useState } from 'react';
import axios from 'axios';
import Link from 'next/link';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';
const api = axios.create({
  baseURL: API_BASE,
  timeout: 20000,
  withCredentials: true,
});

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [sessionUser, setSessionUser] = useState(null);
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    api.get('/api/auth/verify')
      .then((response) => setSessionUser(response.data.user))
      .catch(() => setSessionUser(null))
      .finally(() => setIsHydrated(true));
  }, []);

  async function handleSubmit(event) {
    event.preventDefault();
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const endpoint = isRegister ? 'register' : 'login';
      const payload = isRegister ? { email, password, name } : { email, password };
      const response = await api.post(`/api/auth/${endpoint}`, payload);
      setSessionUser(response.data.user);
      setSuccess(isRegister ? 'Registration successful. Redirecting...' : 'Login successful. Redirecting...');

      window.setTimeout(() => {
        window.location.href = '/';
      }, 900);
    } catch (err) {
      setError(err.response?.data?.error || 'Authentication is unavailable right now.');
    } finally {
      setLoading(false);
    }
  }

  async function logout() {
    await api.post('/api/auth/logout');
    setSessionUser(null);
  }

  if (!isHydrated) {
    return null;
  }

  if (sessionUser) {
    return (
      <main className="min-h-screen bg-[#07120f] px-4 py-10 text-stone-50">
        <section className="mx-auto flex min-h-[80vh] max-w-md items-center">
          <div className="w-full rounded-[2rem] border border-white/10 bg-slate-950/70 p-8 text-center shadow-2xl">
            <p className="text-sm font-bold uppercase tracking-[0.25em] text-emerald-200">Signed in</p>
            <h1 className="mt-3 text-3xl font-black">You are already logged in.</h1>
            <div className="mt-6 grid gap-3">
              <Link
                href="/"
                className="rounded-2xl bg-emerald-300 px-4 py-3 font-black text-emerald-950"
              >
                Go to dashboard
              </Link>
              <button
                onClick={logout}
                className="rounded-2xl border border-white/10 px-4 py-3 font-black text-stone-200"
              >
                Sign out
              </button>
            </div>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#07120f] px-4 py-10 text-stone-50">
      <section className="mx-auto grid min-h-[80vh] max-w-5xl items-center gap-8 lg:grid-cols-[1fr_0.9fr]">
        <div>
          <p className="mb-3 inline-flex rounded-full border border-emerald-300/30 bg-emerald-300/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.28em] text-emerald-200">
            NexTrade
          </p>
          <h1 className="text-5xl font-black tracking-[-0.05em]">
            Save your watchlist and keep your market workspace together.
          </h1>
          <p className="mt-4 max-w-xl text-sm leading-6 text-stone-300">
            This demo uses in-memory accounts and an HttpOnly session cookie for local development. Add a database before using auth in production.
          </p>
        </div>

        <div className="rounded-[2rem] border border-white/10 bg-slate-950/70 p-6 shadow-2xl">
          <h2 className="text-2xl font-black">{isRegister ? 'Create account' : 'Sign in'}</h2>
          <p className="mt-2 text-sm text-stone-400">
            {isRegister ? 'Use 8 to 128 characters for your password.' : 'Welcome back to your dashboard.'}
          </p>

          {error && (
            <div className="mt-5 rounded-2xl border border-rose-300/30 bg-rose-950/70 p-3 text-sm text-rose-100">
              {error}
            </div>
          )}

          {success && (
            <div className="mt-5 rounded-2xl border border-emerald-300/30 bg-emerald-950/70 p-3 text-sm text-emerald-100">
              {success}
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-6 grid gap-4">
            {isRegister && (
              <label className="grid gap-2 text-sm font-bold text-stone-300">
                Name
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="h-12 rounded-2xl border border-white/10 bg-black/30 px-4 text-white outline-none focus:border-emerald-200/60"
                  placeholder="Your name"
                  required
                />
              </label>
            )}

            <label className="grid gap-2 text-sm font-bold text-stone-300">
              Email
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="h-12 rounded-2xl border border-white/10 bg-black/30 px-4 text-white outline-none focus:border-emerald-200/60"
                placeholder="you@example.com"
                required
              />
            </label>

            <label className="grid gap-2 text-sm font-bold text-stone-300">
              Password
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="h-12 rounded-2xl border border-white/10 bg-black/30 px-4 text-white outline-none focus:border-emerald-200/60"
                  placeholder="At least 8 characters"
                  minLength={8}
                  maxLength={128}
                  required
              />
            </label>

            <button
              type="submit"
              disabled={loading}
              className="mt-2 h-12 rounded-2xl bg-emerald-300 font-black text-emerald-950 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? 'Working...' : isRegister ? 'Create account' : 'Sign in'}
            </button>
          </form>

          <button
            type="button"
            onClick={() => {
              setIsRegister((current) => !current);
              setError('');
              setSuccess('');
            }}
            className="mt-5 w-full text-center text-sm font-bold text-amber-200"
          >
            {isRegister ? 'Already have an account? Sign in' : 'Need an account? Create one'}
          </button>
        </div>
      </section>
    </main>
  );
}
