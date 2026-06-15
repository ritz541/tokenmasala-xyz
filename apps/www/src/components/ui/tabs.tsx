import { cn } from "../../lib/cn";

interface TabsProps<Value extends string> {
  options: { label: string; value: Value }[];
  value: Value;
  onChange: (value: Value) => void;
}

/** A segmented control: pick one option from a small inline set. */
function Tabs<Value extends string>({ options, value, onChange }: TabsProps<Value>) {
  return (
    <div className="inline-flex border border-border p-0.5">
      {options.map((option) => (
        <button
          className={cn(
            "px-2.5 py-1 text-xs font-medium transition-colors",
            option.value === value
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export { Tabs };
