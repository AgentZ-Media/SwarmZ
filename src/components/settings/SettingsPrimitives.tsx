import type { ReactNode } from "react";
import { Switch } from "@/components/ui/switch";

export function SettingsSection({
  label,
  sub,
  children,
}: {
  label: string;
  sub?: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="font-mono text-10 font-medium uppercase tracking-[.08em] text-fnt">
        {label}
      </div>
      {sub && <p className="mt-1 text-11 leading-relaxed text-fnt">{sub}</p>}
      <div className="mt-2">{children}</div>
    </section>
  );
}

export function SettingsRow({
  label,
  help,
  children,
}: {
  label: string;
  help?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-line py-3">
      <div className="min-w-0 flex-1">
        <div className="text-13 font-medium text-txt">{label}</div>
        {help && (
          <div className="mt-0.5 text-11 leading-relaxed text-fnt">{help}</div>
        )}
      </div>
      {children && (
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      )}
    </div>
  );
}

export function SettingsToggleCard({
  title,
  sub,
  checked,
  onChange,
}: {
  title: string;
  sub: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-line bg-card p-3">
      <div className="min-w-0">
        <div className="text-13 font-medium text-txt">{title}</div>
        <div className="mt-0.5 text-11 leading-relaxed text-fnt">{sub}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} label={title} />
    </div>
  );
}

export function SettingsInfoRow({
  title,
  text,
}: {
  title: string;
  text: string;
}) {
  return (
    <div className="px-3 py-1">
      <div className="text-13 font-medium text-txt">{title}</div>
      <div className="mt-0.5 text-11 leading-relaxed text-fnt">{text}</div>
    </div>
  );
}
