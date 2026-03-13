interface EmptyStateProps {
  icon: string;
  title: string;
  description: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center px-8 py-16 text-center font-[Inter,sans-serif]">
      <div className="w-16 h-16 rounded-[20px] bg-wc-surface border border-wc-border flex items-center justify-center text-[28px] mb-5">
        {icon}
      </div>
      <div className="text-base font-semibold text-wc-text-primary mb-2">
        {title}
      </div>
      <div className="text-[13px] text-wc-text-secondary max-w-[280px] leading-5">
        {description}
      </div>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-6 px-5 py-2.5 rounded-xl bg-wc-accent border-none text-white text-[13px] font-semibold cursor-pointer font-[Inter,sans-serif] transition-all duration-150 hover:brightness-115"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
