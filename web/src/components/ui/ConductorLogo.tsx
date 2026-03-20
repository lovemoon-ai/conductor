import Image from "next/image";

type ConductorLogoProps = {
  title: string;
  subtitle?: string;
  className?: string;
  iconClassName?: string;
  titleClassName?: string;
  subtitleClassName?: string;
  priority?: boolean;
};

const joinClasses = (...classes: Array<string | undefined>) => classes.filter(Boolean).join(" ");

export function ConductorLogo({
  title,
  subtitle,
  className,
  iconClassName,
  titleClassName,
  subtitleClassName,
  priority = false,
}: ConductorLogoProps) {
  return (
    <div className={joinClasses("flex items-center gap-3", className)}>
      <Image
        src="/icon.svg"
        alt=""
        aria-hidden="true"
        width={44}
        height={44}
        priority={priority}
        className={joinClasses("h-11 w-11 shrink-0 rounded-xl", iconClassName)}
      />
      <div className="min-w-0">
        <div
          className={joinClasses(
            "text-lg font-semibold leading-none",
            titleClassName ? undefined : "text-[var(--ink)]",
            titleClassName
          )}
        >
          {title}
        </div>
        {subtitle ? (
          <p
            className={joinClasses(
              "mt-1 text-xs leading-none",
              subtitleClassName ? undefined : "text-[var(--muted)]",
              subtitleClassName
            )}
          >
            {subtitle}
          </p>
        ) : null}
      </div>
    </div>
  );
}
