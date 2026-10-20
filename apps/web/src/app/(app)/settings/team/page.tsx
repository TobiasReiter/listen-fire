"use client";

/**
 * `/settings/team` — who is on the team, who is invited, and everything a team
 * needs to manage its own people. Inviting an address IS the invitation:
 * nothing is emailed and the person joins the next time they sign in, so the
 * page says that rather than promising a link. Adding someone directly puts
 * them on the team at once. Removing a member signs them out. A read-only
 * member sees the roster and nothing they could change.
 *
 */

import { useState } from "react";
import { Bot, MailPlus, Pencil, Phone, UserMinus, UserPlus, X } from "lucide-react";

import { neverAsAny } from "movement-lang";

import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui";
import { usePageTitle } from "@/components/page-title";

import { Card } from "../card";

type Access = "read" | "write";

const INPUT_CLASS =
  "w-64 max-w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] text-slate-900 outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 disabled:bg-slate-50 disabled:text-slate-400";

const isEmail = (value: string) => /.+@.+\..+/.test(value);

function AccessToggle({
  value,
  onChange,
  disabled,
  testId,
}: {
  value: Access;
  onChange: (access: Access) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const options: { access: Access; label: string }[] = [
    { access: "write", label: "Full access" },
    { access: "read", label: "Read-only" },
  ];
  return (
    <div
      className="inline-flex shrink-0 rounded-md border border-slate-200 p-0.5"
      data-testid={testId}
    >
      {options.map((o) => (
        <button
          key={o.access}
          type="button"
          onClick={() => o.access !== value && onChange(o.access)}
          disabled={disabled}
          aria-pressed={o.access === value}
          className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-60 ${
            o.access === value
              ? "bg-slate-900 text-white"
              : "text-slate-500 hover:text-slate-800"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ErrorLine({ message, testId }: { message: string | null; testId: string }) {
  if (!message) return null;
  return (
    <p className="mt-2 text-[12px] text-red-600" data-testid={testId}>
      {message}
    </p>
  );
}

/** Invite by address (joins at next sign-in) or add directly (joins now). */
function AddMemberCard({ onChanged }: { onChanged: () => void }) {
  const [mode, setMode] = useState<"invite" | "direct">("invite");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [access, setAccess] = useState<Access>("write");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const succeed = (message: string) => {
    setDone(message);
    setEmail("");
    setUsername("");
    setError(null);
    onChanged();
  };

  const invite = trpc.views.teamMembers.invite.useMutation({
    onSuccess: () => succeed(`${email} can now sign in to this workspace.`),
    onError: (e) => setError(e.message),
  });
  const addMember = trpc.views.teamMembers.addMember.useMutation({
    onSuccess: () => succeed(`${email} is now a member.`),
    onError: (e) => setError(e.message),
  });

  const busy = invite.isLoading || addMember.isLoading;
  const valid = isEmail(email) && (mode === "invite" || username.trim().length > 0);
  const submit = () => {
    if (!valid || busy) return;
    if (mode === "invite") invite.mutate({ email });
    else addMember.mutate({ email, username: username.trim(), access });
  };

  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <p className="text-[13px] font-semibold text-slate-900">Add a teammate</p>
        <div className="inline-flex rounded-md border border-slate-200 p-0.5">
          {(
            [
              ["invite", "Invite by email"],
              ["direct", "Add directly"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                setError(null);
                setDone(null);
              }}
              aria-pressed={mode === m}
              data-testid={`team-add-mode-${m}`}
              className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                mode === m ? "bg-slate-900 text-white" : "text-slate-500 hover:text-slate-800"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-slate-500">
        {mode === "invite"
          ? "They join this workspace the next time they sign in with this address. Nothing is emailed — they just sign in with this address and land here."
          : "They are on the team straight away. If the address already has an account, that account joins."}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setDone(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="teammate@company.com"
          disabled={busy}
          data-testid="team-invite-email"
          className={INPUT_CLASS}
        />
        {mode === "direct" && (
          <>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="Name"
              disabled={busy}
              data-testid="team-add-username"
              className={`${INPUT_CLASS} w-40`}
            />
            <AccessToggle value={access} onChange={setAccess} disabled={busy} />
          </>
        )}
        <Button
          variant="primary"
          size="sm"
          onClick={submit}
          disabled={!valid || busy}
          data-testid="team-invite-submit"
        >
          <UserPlus size={13} />
          {busy ? "Adding…" : "Add"}
        </Button>
      </div>
      <ErrorLine message={error} testId="team-invite-error" />
      {done && !error && (
        <p className="mt-2 text-[12px] text-emerald-600" data-testid="team-invite-sent">
          {done}
        </p>
      )}
    </Card>
  );
}

/** A mailbox that acts as a member, e.g. an address other tools forward to. */
function ServiceAccountCard({ onChanged }: { onChanged: () => void }) {
  const [email, setEmail] = useState("");
  const [access, setAccess] = useState<Access>("write");
  const [error, setError] = useState<string | null>(null);

  const create = trpc.views.teamMembers.createServiceAccount.useMutation({
    onSuccess: () => {
      setEmail("");
      setError(null);
      onChanged();
    },
    onError: (e) => setError(e.message),
  });
  const valid = isEmail(email);
  const submit = () => valid && !create.isLoading && create.mutate({ email, access });

  return (
    <Card>
      <p className="text-[13px] font-semibold text-slate-900">Create a service account</p>
      <p className="mt-1 text-[12px] leading-relaxed text-slate-500">
        A shared mailbox that acts as a member of the team. It also receives mail
        sent to its address with a +suffix.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="deals@company.com"
          disabled={create.isLoading}
          data-testid="team-service-email"
          className={INPUT_CLASS}
        />
        <AccessToggle value={access} onChange={setAccess} disabled={create.isLoading} />
        <Button
          variant="primary"
          size="sm"
          onClick={submit}
          disabled={!valid || create.isLoading}
          data-testid="team-service-submit"
        >
          <Bot size={13} />
          {create.isLoading ? "Creating…" : "Create"}
        </Button>
      </div>
      <ErrorLine message={error} testId="team-service-error" />
    </Card>
  );
}

type Member = {
  userId: string;
  username: string;
  emails: { email: string; isPrimary: boolean }[];
  phoneNumber: string | null;
  access: Access;
  isServiceAccount: boolean;
  soleTeam: boolean;
  platformAdmin: boolean;
};

/** Why this team may not change a member's name, addresses or number, if it may not. */
function identityLockedReason(member: Member): string | null {
  if (member.platformAdmin) {
    return "A platform admin, so only platform admins can change their name, email or phone.";
  }
  if (!member.soleTeam) {
    return "Also on another team, so only they can change their name, email or phone.";
  }
  return null;
}

/** Remove, and demoting yourself, take a second click — neither is easy to undo. */
type Confirming = "remove" | "demote-self";

type Editor = "rename" | "email" | "phone";

function MemberRow({
  member,
  canWrite,
  isSelf,
  onChanged,
}: {
  member: Member;
  canWrite: boolean;
  isSelf: boolean;
  onChanged: () => void;
}) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [value, setValue] = useState("");
  const [makePrimary, setMakePrimary] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const settle = {
    onSuccess: () => {
      setEditor(null);
      setValue("");
      setMakePrimary(false);
      setConfirming(null);
      setError(null);
      onChanged();
    },
    onError: (e: { message: string }) => {
      setConfirming(null);
      setError(e.message);
    },
  };
  const setAccess = trpc.views.teamMembers.setAccess.useMutation(settle);
  const rename = trpc.views.teamMembers.rename.useMutation(settle);
  const addEmail = trpc.views.teamMembers.addEmail.useMutation(settle);
  const addPhone = trpc.views.teamMembers.addPhone.useMutation(settle);
  const remove = trpc.views.teamMembers.remove.useMutation(settle);

  const busy =
    setAccess.isLoading ||
    rename.isLoading ||
    addEmail.isLoading ||
    addPhone.isLoading ||
    remove.isLoading;

  const open = (next: Editor) => {
    setEditor(editor === next ? null : next);
    setValue(next === "rename" ? member.username : "");
    setMakePrimary(false);
    setError(null);
  };

  const editorValid =
    editor === "email" ? isEmail(value) : value.trim().length > 0;
  const save = () => {
    if (!editorValid || busy || editor === null) return;
    const userId = member.userId;
    switch (editor) {
      case "rename":
        rename.mutate({ userId, username: value.trim() });
        return;
      case "email":
        addEmail.mutate({ userId, email: value.trim(), isPrimary: makePrimary });
        return;
      case "phone":
        addPhone.mutate({ userId, phoneNumber: value.trim() });
        return;
      default:
        neverAsAny(editor);
    }
  };

  const changeAccess = (next: Access) => {
    if (isSelf && next === "read") {
      setError(null);
      setConfirming("demote-self");
      return;
    }
    setAccess.mutate({ userId: member.userId, access: next });
  };

  const confirm = () => {
    if (confirming === null || busy) return;
    switch (confirming) {
      case "remove":
        remove.mutate({ userId: member.userId });
        return;
      case "demote-self":
        setAccess.mutate({ userId: member.userId, access: "read" });
        return;
      default:
        neverAsAny(confirming);
    }
  };

  const lockedReason = identityLockedReason(member);

  const actionClass =
    "flex items-center gap-1 text-[12px] font-medium text-slate-400 transition-colors hover:text-slate-700";

  return (
    <div className="py-3" data-testid="team-member-row">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-[13px] text-slate-700">{member.username}</p>
            {member.isServiceAccount && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-600"
                data-testid="team-member-service"
              >
                <Bot size={11} />
                Service account
              </span>
            )}
          </div>
          {member.emails.map((e) => (
            <p key={e.email} className="truncate text-[11px] text-slate-400">
              {e.email}
              {e.isPrimary && member.emails.length > 1 && " (primary)"}
            </p>
          ))}
          {member.phoneNumber && (
            <p className="truncate text-[11px] text-slate-400">{member.phoneNumber}</p>
          )}
          {canWrite && lockedReason !== null && (
            <p className="text-[11px] text-slate-400" data-testid="team-member-identity-locked">
              {lockedReason}
            </p>
          )}
        </div>
        {!canWrite ? (
          <span className="shrink-0 text-[11px] font-medium text-slate-500" data-testid="team-member-access-label">
            {member.access === "write" ? "Full access" : "Read-only"}
          </span>
        ) : confirming !== null ? (
          <div className="flex shrink-0 items-center gap-1" data-testid="team-member-confirm">
            <span className="text-[12px] text-slate-500">
              {confirming === "remove"
                ? `Remove ${member.username}? They are signed out.`
                : "Make yourself read-only? You will no longer be able to manage the team."}
            </span>
            <button
              onClick={confirm}
              disabled={busy}
              className="rounded px-2 py-1 text-[12px] text-red-600 hover:bg-red-50 disabled:opacity-50"
              data-testid="team-member-confirm-yes"
            >
              Confirm
            </button>
            <button
              onClick={() => setConfirming(null)}
              disabled={busy}
              className="rounded px-2 py-1 text-[12px] text-gray-500 hover:bg-gray-100 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex shrink-0 flex-wrap items-center gap-3">
            <AccessToggle
              value={member.access}
              onChange={changeAccess}
              disabled={busy}
              testId="team-member-access"
            />
            {lockedReason === null && (
              <>
                <button onClick={() => open("rename")} className={actionClass} data-testid="team-member-rename">
                  <Pencil size={12} />
                  Rename
                </button>
                <button onClick={() => open("email")} className={actionClass} data-testid="team-member-add-email">
                  <MailPlus size={12} />
                  Email
                </button>
                <button onClick={() => open("phone")} className={actionClass} data-testid="team-member-add-phone">
                  <Phone size={12} />
                  {member.phoneNumber ? "Change phone" : "Phone"}
                </button>
              </>
            )}
            <button
              onClick={() => {
                setError(null);
                setConfirming("remove");
              }}
              disabled={busy}
              className="flex items-center gap-1 text-[12px] font-medium text-slate-400 transition-colors hover:text-red-600"
              data-testid="team-member-remove"
            >
              <UserMinus size={12} />
              Remove
            </button>
          </div>
        )}
      </div>
      {canWrite && editor !== null && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            autoFocus
            type={editor === "email" ? "email" : editor === "phone" ? "tel" : "text"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") setEditor(null);
            }}
            placeholder={
              editor === "email" ? "another@company.com" : editor === "phone" ? "+44 7700 900000" : "Name"
            }
            disabled={busy}
            data-testid="team-member-editor"
            className={INPUT_CLASS}
          />
          {editor === "email" && (
            <label className="flex items-center gap-1.5 text-[12px] text-slate-500">
              <input
                type="checkbox"
                checked={makePrimary}
                onChange={(e) => setMakePrimary(e.target.checked)}
                disabled={busy}
              />
              Make primary
            </label>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={save}
            disabled={!editorValid || busy}
            data-testid="team-member-editor-save"
          >
            Save
          </Button>
          <button
            onClick={() => setEditor(null)}
            className="text-[12px] font-medium text-slate-400 hover:text-slate-700"
          >
            Cancel
          </button>
        </div>
      )}
      <ErrorLine message={error} testId="team-member-error" />
    </div>
  );
}

export default function TeamPage() {
  usePageTitle("Team — TARS");

  const overview = trpc.views.teamMembers.overview.useQuery();
  const utils = trpc.useUtils();
  const refresh = () => void utils.views.teamMembers.overview.invalidate();

  const revoke = trpc.views.teamMembers.revokeInvite.useMutation({
    onSuccess: refresh,
  });

  if (overview.isLoading || !overview.data) {
    return (
      <div className="py-10 text-center text-[13px] text-slate-400">Loading…</div>
    );
  }

  const { viewer, members, invites } = overview.data;
  const canWrite = viewer.access === "write";

  return (
    <div className="space-y-5">
      {canWrite ? (
        <>
          <AddMemberCard onChanged={refresh} />
          <ServiceAccountCard onChanged={refresh} />
        </>
      ) : (
        <p className="text-[12px] text-slate-500" data-testid="team-read-only">
          You have read-only access, so you can see the team but not change it.
        </p>
      )}

      {/* Pending invites */}
      {invites.length > 0 && (
        <Card>
          <p className="text-[13px] font-semibold text-slate-900">
            Invited, not yet signed in
          </p>
          <div className="mt-3 divide-y divide-slate-100">
            {invites.map((i) => (
              <div
                key={i.id}
                className="flex items-center justify-between gap-4 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-[13px] text-slate-700">{i.email}</p>
                  <p className="text-[11px] text-slate-400">
                    Added {new Date(i.createdAt).toLocaleDateString()}
                  </p>
                </div>
                {canWrite && (
                  <button
                    onClick={() => revoke.mutate({ inviteId: i.id })}
                    disabled={revoke.isLoading}
                    className="flex shrink-0 items-center gap-1 text-[12px] font-medium text-slate-400 transition-colors hover:text-red-600"
                    data-testid="team-invite-revoke"
                  >
                    <X size={12} />
                    Withdraw
                  </button>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Members */}
      <Card>
        <p className="text-[13px] font-semibold text-slate-900">Members</p>
        <div className="mt-1 divide-y divide-slate-100">
          {members.map((m) => (
            <MemberRow
              key={m.userId}
              member={m}
              canWrite={canWrite}
              isSelf={m.userId === viewer.userId}
              onChanged={refresh}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}
