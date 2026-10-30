"use client";

import { useState, useEffect, useCallback, useMemo } from "react";

import { Button, buttonClass } from "@/components/ui";
import { useCapabilities, useCapabilitiesSettled } from "@/lib/capabilities-provider";
import { trpc } from "@/lib/trpc";

import { Card } from "./card";

const inputClass =
  "w-full rounded-md border border-gray-200 px-3 py-2 text-[13px] focus:border-gray-400 focus:outline-none";
const btnPrimary =
  "rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-primary-600 disabled:opacity-50";
// A format hint only — the reserved UK range, never a routable number.
const EXAMPLE_PHONE_NUMBER = "+447700900000";
const btnSecondary =
  "rounded-md border border-gray-200 px-3 py-1.5 text-[13px] font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50";

export default function SettingsPage() {
  return (
    <div className="space-y-4">
      <ConnectClaudeSection />
      <UsageSection />
      <BillingContactsSection />
      <WhatsAppSection />
      <StylePreferencesSection />
      <RecipesSection />
      <PasswordSection />
      <VersionSection />
    </div>
  );
}

/**
 * `NEXT_PUBLIC_CLAUDE_DIRECTORY_URL` is a build-time flag: set it only for the
 * one deployment Anthropic lists in Claude's connector directory, and this
 * offers the one-click "add from the directory" link. Every other deployment,
 * every self-host included, has no listing of its own, so it falls back to the
 * custom-connector steps pointed at THIS install's own automation MCP URL (read
 * from capabilities, never guessed from the browser's origin: a reverse proxy
 * or a different public hostname would make that guess wrong).
 */
const CLAUDE_DIRECTORY_URL = process.env.NEXT_PUBLIC_CLAUDE_DIRECTORY_URL;
const CLAUDE_CONNECTORS_URL = "https://claude.ai/settings/connectors";
const SKILL_FILE = "/listen-fire-builder.skill";
const CLAUDE_SKILLS_SETTINGS_URL = "https://claude.ai/new#settings/customize-skills";
const externalLinkClass =
  "underline decoration-gray-200 underline-offset-2 hover:text-gray-600";

/** Automations are built in Claude: the connector gives Claude the tools, the
 *  skill teaches it how to use them. */
function ConnectClaudeSection() {
  return (
    <Card id="connect" testId="settings-connect-section">
      <h2 className="text-[13px] font-semibold text-gray-900">Connect Claude</h2>
      <p className="mt-1 text-[12px] text-gray-400">
        You build automations by talking to Claude. Add KIPP to Claude, then
        teach it the skill.
      </p>

      <h3 className="mt-5 text-[13px] font-medium text-gray-900">
        Add KIPP to Claude
      </h3>
      <div className="mt-2">
        {CLAUDE_DIRECTORY_URL ? (
          <a
            href={CLAUDE_DIRECTORY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClass({ variant: "primary" })}
            data-testid="add-to-claude"
          >
            Add KIPP to Claude
          </a>
        ) : (
          <ConnectorUrlSteps />
        )}
      </div>
      <p className="mt-2 text-[12px] text-gray-400">
        Team plan? Your Claude admin may need to add it.
      </p>

      <h3 className="mt-5 text-[13px] font-medium text-gray-900">
        Teach Claude the skill
      </h3>
      <div className="mt-2">
        <a
          href={SKILL_FILE}
          download="listen-fire-builder.skill"
          className={buttonClass({ variant: "secondary" })}
          data-testid="download-skill"
        >
          Download the skill
        </a>
      </div>
      <p className="mt-2 text-[12px] text-gray-400">
        Then upload it in{" "}
        <a
          href={CLAUDE_SKILLS_SETTINGS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={externalLinkClass}
        >
          Claude&apos;s skill settings
        </a>
        .
      </p>
    </Card>
  );
}

/** The self-hosted flow: copy this install's own connector URL, then walk
 *  through Claude's custom-connector dialog by hand. */
function ConnectorUrlSteps() {
  const [copied, setCopied] = useState(false);
  const capabilities = useCapabilities();
  const settled = useCapabilitiesSettled();
  const url = capabilities?.mcp?.automation;

  // A deployment that does not run automations has nothing to connect Claude
  // to: say so rather than offering to copy a URL that doesn't exist.
  if (settled && !url) {
    return (
      <p className="text-[12px] text-gray-500" data-testid="connect-unavailable">
        This deployment doesn&apos;t run automations, so there&apos;s no connector to add.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <Button
        variant="primary"
        disabled={!url}
        onClick={() => {
          if (!url) return;
          void navigator.clipboard.writeText(url).then(() => setCopied(true));
        }}
        data-testid="copy-connector-url"
      >
        {copied ? "Copied" : "Copy the link"}
      </Button>
      <ol className="list-decimal space-y-1 pl-4 text-[12px] text-gray-500">
        <li>
          Open Claude, then{" "}
          <a
            href={CLAUDE_CONNECTORS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={externalLinkClass}
          >
            Settings → Connectors
          </a>
        </li>
        <li>Choose &quot;Add custom connector&quot;</li>
        <li>Paste the link you just copied</li>
        <li>Claude sends you back here to sign in</li>
      </ol>
    </div>
  );
}

// Which release this installation is running. It comes from the API rather
// than from anything the browser bundle knows, because the version belongs to
// the deployed process — a cached page served by an old web build would
// otherwise report the version it was built beside.
function VersionSection() {
  const { data } = trpc.views.userSettings.getDeployment.useQuery();
  if (!data) return null;

  return (
    <Card testId="settings-version-section">
      <h2 className="text-[13px] font-semibold text-gray-900">About</h2>
      <p className="mt-1 text-[12px] text-gray-400">
        Running KIPP{" "}
        <span className="font-mono text-gray-600">{data.version}</span>.
      </p>
    </Card>
  );
}

function WhatsAppSection() {
  const { data: deployment, isLoading: isLoadingNumber } =
    trpc.views.userSettings.getDeployment.useQuery();
  const { data, isLoading } =
    trpc.views.userSettings.getPhoneNumber.useQuery();
  const utils = trpc.useUtils();

  const { mutateAsync: startVerification, isLoading: isSending } =
    trpc.views.userSettings.startPhoneVerification.useMutation();
  const { mutateAsync: confirmVerification, isLoading: isConfirming } =
    trpc.views.userSettings.confirmPhoneVerification.useMutation();

  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"enter" | "code">("enter");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const verified = data?.verifiedAt ? data : null;
  const busy = isSending || isConfirming;
  // Only labels the button; what happens after a press follows what the link
  // call answers, so a label and a flow can never disagree about a code.
  const linksWithoutCode = deployment?.whatsappLinkVerification === "trust";

  const startMessages: Record<string, string> = {
    number_taken: "That number is already linked to another account.",
    cooldown: "A code was just sent. Wait a minute before trying again.",
    too_many_sends: "Too many codes requested. Try again later.",
  };
  const confirmMessages: Record<string, string> = {
    no_active_code: "No code is waiting. Send a new one.",
    expired: "That code expired. Send a new one.",
    too_many_attempts: "Too many wrong attempts. Send a new code.",
    invalid_code: "That code is not right. Check it and try again.",
    no_code_needed: "No code is needed. Link the number again.",
  };

  const handleSend = async () => {
    setError(null);
    setSuccess(null);
    if (!phone.trim()) {
      setError(
        `Enter your number in full international format, e.g. ${EXAMPLE_PHONE_NUMBER}.`,
      );
      return;
    }
    try {
      const res = await startVerification({ phoneNumber: phone.trim() });
      if (!res.ok) {
        setError(startMessages[res.reason] ?? "Could not send a code.");
        return;
      }
      if (res.outcome === "linked") {
        setStage("enter");
        setEditing(false);
        setSuccess("Number linked.");
        await utils.views.userSettings.getPhoneNumber.invalidate();
        return;
      }
      setStage("code");
      setSuccess("Code sent on WhatsApp. Enter it below.");
    } catch {
      setError("Something went wrong. Please try again.");
    }
  };

  const handleConfirm = async () => {
    setError(null);
    setSuccess(null);
    if (!code.trim()) {
      setError("Enter the code you received.");
      return;
    }
    try {
      const res = await confirmVerification({ phoneNumber: phone.trim(), code: code.trim() });
      if (!res.ok) {
        setError(confirmMessages[res.reason] ?? "Could not verify that code.");
        return;
      }
      setCode("");
      setStage("enter");
      setEditing(false);
      setSuccess("Number verified.");
      await utils.views.userSettings.getPhoneNumber.invalidate();
    } catch {
      setError("Something went wrong. Please try again.");
    }
  };

  // No number registered on this deployment means there is nothing to verify
  // against, so the section is not offered at all.
  if (isLoadingNumber || !deployment?.whatsappNumber) return null;

  return (
    <Card testId="settings-whatsapp-section">
      <h2 className="text-[13px] font-semibold text-gray-900">WhatsApp</h2>
      <p className="mt-1 text-[12px] text-gray-400">
        {linksWithoutCode ? "Link" : "Verify"} your WhatsApp number so messages you send to{" "}
        {deployment.whatsappNumber} run your automations.
      </p>

      {isLoading ? (
        <div className="mt-3 h-16 animate-pulse rounded-md bg-gray-100" />
      ) : verified && !editing ? (
        <div className="mt-3 flex items-center gap-3">
          <span className="text-[13px] text-gray-900">
            ✓ {verified.phoneNumber} verified
          </span>
          <button
            className={btnSecondary}
            onClick={() => {
              setEditing(true);
              setPhone("");
              setStage("enter");
              setError(null);
              setSuccess(null);
            }}
          >
            Change number
          </button>
        </div>
      ) : (
        <>
          <div className="mt-3 max-w-sm space-y-2">
            <input
              type="tel"
              className={inputClass}
              placeholder={EXAMPLE_PHONE_NUMBER}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={busy || stage === "code"}
            />
            {stage === "code" && (
              <input
                type="text"
                inputMode="numeric"
                className={inputClass}
                placeholder="6-digit code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={busy}
              />
            )}
          </div>
          <div className="mt-3 flex items-center gap-3">
            {stage === "enter" ? (
              <button
                onClick={handleSend}
                disabled={busy}
                className={btnPrimary}
                data-testid="settings-send-code"
              >
                {linksWithoutCode ? "Link number" : "Send code"}
              </button>
            ) : (
              <>
                <button
                  onClick={handleConfirm}
                  disabled={busy}
                  className={btnPrimary}
                  data-testid="settings-verify-code"
                >
                  Verify
                </button>
                <button onClick={handleSend} disabled={busy} className={btnSecondary}>
                  Resend
                </button>
              </>
            )}
            {error && <span className="text-[12px] text-red-600">{error}</span>}
            {success && <span className="text-[12px] text-gray-400">{success}</span>}
          </div>
        </>
      )}
    </Card>
  );
}

function PasswordSection() {
  const { data, isLoading } = trpc.views.account.getPasswordStatus.useQuery();
  const utils = trpc.useUtils();

  const { mutateAsync: setPassword, isLoading: isSetting } =
    trpc.views.account.setPassword.useMutation();
  const { mutateAsync: changePassword, isLoading: isChanging } =
    trpc.views.account.changePassword.useMutation();
  const { mutateAsync: removePassword, isLoading: isRemoving } =
    trpc.views.account.removePassword.useMutation();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const busy = isSetting || isChanging || isRemoving;

  const resetFields = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  };

  const validateNew = (): string | null => {
    if (newPassword.length < 8)
      return "Password must be at least 8 characters.";
    if (newPassword !== confirmPassword) return "Passwords do not match.";
    return null;
  };

  const errorMessage = (e: unknown): string =>
    e instanceof Error && e.message
      ? e.message
      : "Something went wrong. Please try again.";

  const handleSet = async () => {
    setError(null);
    setSuccess(null);
    const invalid = validateNew();
    if (invalid) {
      setError(invalid);
      return;
    }
    try {
      await setPassword({ password: newPassword });
      resetFields();
      setSuccess("Password set.");
      await utils.views.account.getPasswordStatus.invalidate();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const handleChange = async () => {
    setError(null);
    setSuccess(null);
    if (!currentPassword) {
      setError("Enter your current password.");
      return;
    }
    const invalid = validateNew();
    if (invalid) {
      setError(invalid);
      return;
    }
    try {
      await changePassword({ currentPassword, newPassword });
      resetFields();
      setSuccess("Password changed.");
      await utils.views.account.getPasswordStatus.invalidate();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const handleRemove = async () => {
    setError(null);
    setSuccess(null);
    try {
      await removePassword();
      resetFields();
      setConfirmRemove(false);
      setSuccess("Password removed.");
      await utils.views.account.getPasswordStatus.invalidate();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Card testId="settings-password-section">
      <h2 className="text-[13px] font-semibold text-gray-900">Password</h2>

      {isLoading || !data ? (
        <div className="mt-3 h-16 animate-pulse rounded-md bg-gray-100" />
      ) : !data.hasPassword ? (
        <>
          <p className="mt-1 text-[12px] text-gray-400">
            Set a password to sign in with your email and password, in addition
            to Google or Microsoft.
          </p>
          <div className="mt-3 max-w-sm space-y-2">
            <input
              type="password"
              className={inputClass}
              placeholder="New password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={busy}
            />
            <input
              type="password"
              className={inputClass}
              placeholder="Confirm password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={handleSet}
              disabled={busy}
              className={btnPrimary}
              data-testid="settings-set-password"
            >
              Set password
            </button>
            {error && <span className="text-[12px] text-red-600">{error}</span>}
            {success && (
              <span className="text-[12px] text-gray-400">{success}</span>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="mt-1 text-[12px] text-gray-400">
            Change or remove the password used to sign in with your email. You
            can still sign in with Google, Microsoft, or a magic link.
          </p>
          <div className="mt-3 max-w-sm space-y-2">
            <input
              type="password"
              className={inputClass}
              placeholder="Current password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              disabled={busy}
            />
            <input
              type="password"
              className={inputClass}
              placeholder="New password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={busy}
            />
            <input
              type="password"
              className={inputClass}
              placeholder="Confirm new password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={handleChange}
              disabled={busy}
              className={btnPrimary}
              data-testid="settings-change-password"
            >
              Change password
            </button>
            {confirmRemove ? (
              <>
                <button
                  onClick={handleRemove}
                  disabled={busy}
                  className="rounded px-2 py-1.5 text-[13px] font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                  data-testid="settings-remove-password"
                >
                  Confirm remove
                </button>
                <button
                  onClick={() => setConfirmRemove(false)}
                  disabled={busy}
                  className="rounded px-2 py-1.5 text-[13px] text-gray-500 hover:bg-gray-100 disabled:opacity-50"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                onClick={() => {
                  setError(null);
                  setSuccess(null);
                  setConfirmRemove(true);
                }}
                disabled={busy}
                className={btnSecondary}
              >
                Remove password
              </button>
            )}
          </div>
          <div className="mt-2 flex items-center gap-3">
            {error && <span className="text-[12px] text-red-600">{error}</span>}
            {success && (
              <span className="text-[12px] text-gray-400">{success}</span>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

function StylePreferencesSection() {
  const { data, isLoading } =
    trpc.views.userSettings.getAgentStylePreferences.useQuery();
  const { mutateAsync: update } =
    trpc.views.userSettings.updateAgentStylePreferences.useMutation();

  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setValue(data.preferences);
  }, [data]);

  const save = useCallback(async () => {
    await update({ preferences: value });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, [update, value]);

  return (
    <Card>
      <h2 className="text-[13px] font-semibold text-gray-900">
        Agent Style Preferences
      </h2>
      <p className="mt-1 text-[12px] text-gray-400">
        Control how all AI agents communicate — tone, verbosity, formatting.
        These preferences apply to your whole team.
      </p>
      <textarea
        className={`${inputClass} mt-3`}
        rows={5}
        placeholder="e.g. Be concise. Use bullet points. Show financials in USD millions."
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={isLoading}
      />
      <div className="mt-3 flex items-center gap-3">
        <button onClick={save} disabled={isLoading} className={btnPrimary}>
          Save
        </button>
        {saved && (
          <span className="text-[12px] text-gray-400">Saved</span>
        )}
      </div>
    </Card>
  );
}

interface RecipeFormState {
  id?: string;
  name: string;
  description: string;
  instructions: string;
}

const emptyRecipe: RecipeFormState = { name: "", description: "", instructions: "" };

function RecipesSection() {
  const { data: recipes, isLoading } =
    trpc.views.knowledge.recipe.list.useQuery();
  const utils = trpc.useUtils();

  const { mutateAsync: createRecipe } =
    trpc.views.knowledge.recipe.create.useMutation();
  const { mutateAsync: updateRecipe } =
    trpc.views.knowledge.recipe.update.useMutation();
  const { mutateAsync: deleteRecipe } =
    trpc.views.knowledge.recipe.delete.useMutation();

  const [editing, setEditing] = useState<RecipeFormState | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const startCreate = () => setEditing({ ...emptyRecipe });
  const startEdit = (r: { id: string; name: string; description: string; instructions: string }) =>
    setEditing({ id: r.id, name: r.name, description: r.description, instructions: r.instructions });
  const cancel = () => { setEditing(null); setConfirmDeleteId(null); };

  const save = async () => {
    if (!editing) return;
    if (editing.id) {
      await updateRecipe({
        id: editing.id,
        name: editing.name,
        description: editing.description,
        instructions: editing.instructions,
      });
    } else {
      await createRecipe({
        name: editing.name,
        description: editing.description,
        instructions: editing.instructions,
      });
    }
    setEditing(null);
    utils.views.knowledge.recipe.list.invalidate();
  };

  const handleDelete = async (id: string) => {
    await deleteRecipe({ id });
    setConfirmDeleteId(null);
    utils.views.knowledge.recipe.list.invalidate();
  };

  const canSave = editing && editing.name.trim() && editing.instructions.trim();

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[13px] font-semibold text-gray-900">Recipes</h2>
          <p className="mt-1 text-[12px] text-gray-400">
            Reusable instructions the ask agent follows for specific tasks. The
            agent auto-matches recipes to requests.
          </p>
        </div>
        {!editing && (
          <button onClick={startCreate} className={`${btnSecondary} shrink-0`}>
            New
          </button>
        )}
      </div>

      {editing && (
        <div className="mt-4 rounded-md border border-gray-200 p-4">
          <input
            className={inputClass}
            placeholder="Recipe name"
            value={editing.name}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            autoFocus
          />
          <input
            className={`${inputClass} mt-2`}
            placeholder="Short description — when should this recipe be used?"
            value={editing.description}
            onChange={(e) =>
              setEditing({ ...editing, description: e.target.value })
            }
          />
          <textarea
            className={`${inputClass} mt-2`}
            rows={8}
            placeholder="Full instructions for the agent to follow..."
            value={editing.instructions}
            onChange={(e) =>
              setEditing({ ...editing, instructions: e.target.value })
            }
          />
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={save}
              disabled={!canSave}
              className={btnPrimary}
            >
              {editing.id ? "Update" : "Create"}
            </button>
            <button onClick={cancel} className={btnSecondary}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="mt-4">
        {isLoading && (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <div
                key={i}
                className="h-14 animate-pulse rounded-md bg-gray-100"
              />
            ))}
          </div>
        )}
        {recipes && recipes.length === 0 && !editing && (
          <p className="text-[12px] text-gray-400">
            No recipes yet. Create one or ask the agent to save a recipe during
            a conversation.
          </p>
        )}
        {recipes?.map((r) => (
          <div
            key={r.id}
            className="group flex items-center gap-3 border-b border-gray-100 py-3 last:border-0"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-gray-900">
                {r.name}
              </div>
              {r.description && (
                <div className="mt-0.5 text-[12px] text-gray-400 truncate">
                  {r.description}
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100">
              {confirmDeleteId === r.id ? (
                <>
                  <button
                    onClick={() => handleDelete(r.id)}
                    className="rounded px-2 py-1 text-[12px] text-red-600 hover:bg-red-50"
                  >
                    Confirm
                  </button>
                  <button
                    onClick={() => setConfirmDeleteId(null)}
                    className="rounded px-2 py-1 text-[12px] text-gray-500 hover:bg-gray-100"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => startEdit(r)}
                    className="rounded px-2 py-1 text-[12px] text-gray-500 hover:bg-gray-100"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => setConfirmDeleteId(r.id)}
                    className="rounded px-2 py-1 text-[12px] text-gray-500 hover:bg-gray-100"
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function UsageMeter({
  label,
  used,
  weeklyMax,
  additional,
  thresholdPct,
}: {
  label: string;
  used: number;
  weeklyMax: number;
  additional: number;
  thresholdPct: number;
}) {
  const effectiveLimit = weeklyMax + additional;
  const pct = effectiveLimit > 0 ? Math.min(100, (used / effectiveLimit) * 100) : 0;
  const thresholdReached = pct >= thresholdPct;
  const exhausted = used >= effectiveLimit;

  const barColor = exhausted
    ? "bg-red-500"
    : thresholdReached
      ? "bg-amber-500"
      : "bg-gray-400";

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-gray-700">{label}</span>
        <span className="text-[12px] text-gray-400">
          {used} / {effectiveLimit}
        </span>
      </div>
      <div className="mt-1.5 h-2 w-full rounded-full bg-gray-100">
        <div
          className={`h-2 rounded-full transition-all ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {additional > 0 && (
        <div className="mt-1 text-[11px] text-gray-400">
          {Math.max(0, additional - Math.max(0, used - weeklyMax))} additional available
        </div>
      )}
    </div>
  );
}

function UsageSection() {
  const { data, isLoading } = trpc.views.usage.getUsageSummary.useQuery();

  if (isLoading) {
    return (
      <Card>
        <div className="h-24 animate-pulse rounded-md bg-gray-100" />
      </Card>
    );
  }

  if (!data) return null;

  const resetDay = DAY_NAMES[data.weekStartsOn] ?? "Monday";

  return (
    <Card>
      <h2 className="text-[13px] font-semibold text-gray-900">Usage</h2>
      <p className="mt-1 text-[12px] text-gray-400">
        Weekly usage for your team. Resets every {resetDay}.
      </p>
      <div className="mt-3 flex gap-6">
        {data.pipelineRuns && (
          <UsageMeter
            label="Pipeline runs"
            used={data.pipelineRuns.used}
            weeklyMax={data.pipelineRuns.weeklyMax}
            additional={data.pipelineRuns.additional}
            thresholdPct={data.alertThresholdPct}
          />
        )}
        {data.queryInputs && (
          <UsageMeter
            label="Questions"
            used={data.queryInputs.used}
            weeklyMax={data.queryInputs.weeklyMax}
            additional={data.queryInputs.additional}
            thresholdPct={data.alertThresholdPct}
          />
        )}
      </div>
      <div className="mt-4">
        <button disabled className={`${btnSecondary} opacity-50 cursor-not-allowed`}>
          Top up (coming soon)
        </button>
      </div>
    </Card>
  );
}

function BillingContactsSection() {
  const { data: contacts, isLoading } =
    trpc.views.usage.getBillingContacts.useQuery();
  const utils = trpc.useUtils();
  const { mutateAsync: setBillingContact } =
    trpc.views.usage.setBillingContact.useMutation();

  const toggle = async (id: string, current: boolean) => {
    await setBillingContact({ userEmailId: id, isBillingContact: !current });
    utils.views.usage.getBillingContacts.invalidate();
  };

  if (isLoading) {
    return (
      <Card>
        <div className="h-16 animate-pulse rounded-md bg-gray-100" />
      </Card>
    );
  }

  if (!contacts || contacts.length === 0) return null;

  return (
    <Card>
      <h2 className="text-[13px] font-semibold text-gray-900">
        Billing Contacts
      </h2>
      <p className="mt-1 text-[12px] text-gray-400">
        Billing contacts receive usage alerts by email when your team approaches
        or reaches its limits.
      </p>
      <div className="mt-3">
        {contacts.map((c) => (
          <label
            key={c.id}
            className="flex items-center gap-3 rounded-md py-2 px-1 hover:bg-gray-50 cursor-pointer"
          >
            <input
              type="checkbox"
              checked={c.isBillingContact}
              onChange={() => toggle(c.id, c.isBillingContact)}
              className="h-4 w-4 rounded border-gray-300 text-gray-900 focus:ring-gray-500"
            />
            <span className="text-[13px] text-gray-700">{c.email}</span>
          </label>
        ))}
      </div>
    </Card>
  );
}
