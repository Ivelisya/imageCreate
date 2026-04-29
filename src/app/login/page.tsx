"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [authMode, setAuthMode] = useState<"login" | "setup">("login");
  const [setupRequired, setSetupRequired] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function checkExistingSession() {
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store" });
        const session = (await response.json()) as { authenticated?: boolean; setupRequired?: boolean };
        if (!cancelled && session.authenticated) {
          router.replace("/generate");
        }
        if (!cancelled && session.setupRequired) {
          setSetupRequired(true);
          setAuthMode("setup");
        }
      } catch {
        // 本地服务启动时会偶发检查失败，保持表单可用。
      }
    }

    void checkExistingSession();

    return () => {
      cancelled = true;
    };
  }, [router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError("");

    if (authMode === "setup" && password !== confirmPassword) {
      setIsSubmitting(false);
      setError("两次输入的密码不一致。");
      return;
    }

    try {
      const response = await fetch(authMode === "setup" ? "/api/auth/setup" : "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? "登录失败，请检查账号和密码。");
        return;
      }

      router.replace("/generate");
      router.refresh();
    } catch {
      setError("画室暂时无法进入，请稍后再试。");
    } finally {
      setIsSubmitting(false);
    }
  }

  function switchMode(mode: "login" | "setup") {
    setAuthMode(mode);
    setError("");
    setPassword("");
    setConfirmPassword("");
  }

  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-visual">
          <div className="login-brand-row">
            <span className="brand-logo" aria-hidden="true">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img alt="" src="/nailoong-logo.png" />
            </span>
            <div>
              <p className="eyebrow">奶龙志的妙妙画室</p>
            </div>
          </div>
          <div className="login-heading">
            <p className="login-intro" id="login-title">
              {authMode === "setup"
                ? "先设定画室入口，之后只用这一套账号进入。"
                : "私人创作入口，登录后继续生成。"}
            </p>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt="" className="login-mascot" src="/nailoong-logo.png" />
          <span className="login-peek login-peek-one" aria-hidden="true">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt="" src="/nailoong-logo.png" />
          </span>
          <span className="login-peek login-peek-two" aria-hidden="true">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt="" src="/nailoong-logo.png" />
          </span>
          <div className="login-proof">
            <span>文生图</span>
            <span>图 + 文生成</span>
            <span>分辨率可选</span>
          </div>
        </div>

        <div className="login-form-card">
          {setupRequired ? (
            <div className="setup-callout" aria-live="polite">
              <strong>首次登录</strong>
              <span>创建你的专属账号；已有账号可直接登录。</span>
              <div className="auth-mode-switch">
                <button
                  className={authMode === "setup" ? "active" : ""}
                  onClick={() => switchMode("setup")}
                  type="button"
                >
                  创建账号
                </button>
                <button
                  className={authMode === "login" ? "active" : ""}
                  onClick={() => switchMode("login")}
                  type="button"
                >
                  登录
                </button>
              </div>
            </div>
          ) : null}

          <form className="stack" onSubmit={handleSubmit}>
            <label>
              <span>用户名</span>
              <input
                autoComplete="username"
                name="username"
                onChange={(event) => setUsername(event.target.value)}
                placeholder="请输入用户名"
                required
                type="text"
                value={username}
              />
            </label>

            <label>
              <span>密码</span>
              <input
                autoComplete="current-password"
                name="password"
                onChange={(event) => setPassword(event.target.value)}
                placeholder="请输入密码"
                required
                type="password"
                value={password}
              />
            </label>

            {authMode === "setup" ? (
              <label>
                <span>确认密码</span>
                <input
                  autoComplete="new-password"
                  name="confirm-password"
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder="请再次输入密码"
                  required
                  type="password"
                  value={confirmPassword}
                />
              </label>
            ) : null}

            {error ? <p className="form-error">{error}</p> : null}

            <button className="primary-button" disabled={isSubmitting} type="submit">
              {isSubmitting
                ? authMode === "setup"
                  ? "正在创建..."
                  : "正在登录..."
                : authMode === "setup"
                  ? "创建账号"
                  : "进入画室"}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
