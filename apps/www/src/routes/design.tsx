import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Copy, PencilSimple, Trash } from "@phosphor-icons/react/ssr";

import { StatCard } from "../components/stat-card";
import { Avatar } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Button, buttonClassName } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Code } from "../components/ui/code";
import { Input, Textarea } from "../components/ui/input";
import { Menu } from "../components/ui/menu";
import { Tabs } from "../components/ui/tabs";

const Route = createFileRoute("/design")({
  component: DesignPage,
});

/** Token swatches. The `bg-*` class is a complete literal so Tailwind's
 * scanner emits it. */
const COLOR_TOKENS = [
  { name: "background", swatch: "bg-background" },
  { name: "foreground", swatch: "bg-foreground" },
  { name: "muted", swatch: "bg-muted" },
  { name: "muted-foreground", swatch: "bg-muted-foreground" },
  { name: "card", swatch: "bg-card" },
  { name: "card-foreground", swatch: "bg-card-foreground" },
  { name: "border", swatch: "bg-border" },
  { name: "accent", swatch: "bg-accent" },
  { name: "accent-foreground", swatch: "bg-accent-foreground" },
];

const TYPE_SIZES = [
  { label: "text-2xl", className: "text-2xl" },
  { label: "text-xl", className: "text-xl" },
  { label: "text-lg", className: "text-lg" },
  { label: "text-base", className: "text-base" },
  { label: "text-sm", className: "text-sm" },
  { label: "text-xs", className: "text-xs" },
];

const DEMO_TABS = [
  { label: "Spend", value: "spend" as const },
  { label: "Tokens", value: "tokens" as const },
  { label: "Active days", value: "days" as const },
];

function DesignPage() {
  const [tab, setTab] = useState<(typeof DEMO_TABS)[number]["value"]>("spend");

  return (
    <div className="flex flex-col gap-12">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Design system</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The tokens and primitives the site is built from. Colors follow the system appearance.
        </p>
      </header>

      <Section title="Color tokens">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {COLOR_TOKENS.map((token) => (
            <div className="flex flex-col gap-1.5" key={token.name}>
              <div className={`h-16 rounded-lg border border-border ${token.swatch}`} />
              <Code>{token.name}</Code>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Typography">
        <div className="flex flex-col gap-3">
          {TYPE_SIZES.map((size) => (
            <div className="flex items-baseline gap-4" key={size.label}>
              <span className="w-20 shrink-0 text-xs text-muted-foreground">{size.label}</span>
              <span className={size.className}>Maxxing the most tokens</span>
            </div>
          ))}
          <div className="flex items-baseline gap-4">
            <span className="w-20 shrink-0 text-xs text-muted-foreground">font-mono</span>
            <span className="font-mono text-sm">tokenmaxxing sync</span>
          </div>
          <div className="flex items-baseline gap-4">
            <span className="w-20 shrink-0 text-xs text-muted-foreground">weights</span>
            <span className="text-sm">
              <span className="font-normal">normal</span> ·{" "}
              <span className="font-medium">medium</span> ·{" "}
              <span className="font-semibold">semibold</span>
            </span>
          </div>
        </div>
      </Section>

      <Section title="Buttons">
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="primary">
            Primary sm
          </Button>
          <Button size="md" variant="primary">
            Primary md
          </Button>
          <Button disabled size="md" variant="primary">
            Disabled
          </Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
        </div>
        <div className="mt-4 max-w-sm">
          <Button fullWidth size="md" variant="primary">
            Full width
          </Button>
        </div>
      </Section>

      <Section title="Tabs">
        <Tabs onChange={setTab} options={DEMO_TABS} value={tab} />
        <p className="mt-2 text-sm text-muted-foreground">
          Selected: <Code>{tab}</Code>
        </p>
      </Section>

      <Section title="Menu">
        <Menu>
          <Menu.Trigger className={buttonClassName({ size: "sm", variant: "primary" })}>
            Actions
          </Menu.Trigger>
          <Menu.Content align="start">
            <Menu.Item icon={<PencilSimple />}>Edit profile</Menu.Item>
            <Menu.Item icon={<Copy />}>Copy link</Menu.Item>
            <Menu.Separator />
            <Menu.Item
              className="text-red-500 data-[highlighted]:bg-red-500/10 data-[highlighted]:text-red-500"
              icon={<Trash />}
            >
              Delete
            </Menu.Item>
          </Menu.Content>
        </Menu>
        <p className="mt-2 text-sm text-muted-foreground">
          A Base UI dropdown — arrow keys move the highlight, Esc or an outside click closes it.
        </p>
      </Section>

      <Section title="Avatar">
        <div className="flex items-end gap-4">
          <Avatar size={24} src="https://github.com/pondorasti.png" />
          <Avatar size={28} src="https://github.com/pondorasti.png" />
          <Avatar size={56} src="https://github.com/pondorasti.png" />
          <Avatar size={56} src={null} />
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          Sizes 24 / 28 / 56, plus the null-src fallback.
        </p>
      </Section>

      <Section title="Badge">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="muted">muted</Badge>
          <Badge variant="accent">accent</Badge>
        </div>
      </Section>

      <Section title="Input">
        <div className="flex max-w-sm flex-col gap-3">
          <Input placeholder="you@example.com" />
          <Textarea placeholder="Tell us what you maxxed…" rows={3} />
        </div>
      </Section>

      <Section title="Code">
        <p className="text-sm text-muted-foreground">
          Run <Code>npm install -g @851-labs/tokenmaxxing</Code> to install.
        </p>
      </Section>

      <Section title="Card & StatCard">
        <Card className="max-w-sm p-5">
          <h3 className="font-medium">Card</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            A bordered surface on the card background. Pass <Code>className</Code> to override
            padding.
          </p>
        </Card>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Total spend" value="$1,284" />
          <StatCard label="Total tokens" value="48.2M" />
          <StatCard label="Active days" value="63" />
          <StatCard label="Top model" value="Opus" />
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

export { Route };
