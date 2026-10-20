import { useLayoutEffect, useRef } from "react";

/**
 * A text box that grows with its text, so a whole sentence stays readable (especially on a phone).
 * With submitOnEnter, Enter submits the surrounding form like a one-line field; Shift+Enter adds a line.
 */
export function AutoTextarea({
  value,
  onChange,
  submitOnEnter = false,
  className,
  ...rest
}: {
  value: string;
  onChange: (v: string) => void;
  submitOnEnter?: boolean;
  className?: string;
  placeholder?: string;
  autoFocus?: boolean;
  "aria-label"?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      className={`auto-textarea ${className ?? ""}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (submitOnEnter && e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.currentTarget.form?.requestSubmit();
        }
      }}
      {...rest}
    />
  );
}
