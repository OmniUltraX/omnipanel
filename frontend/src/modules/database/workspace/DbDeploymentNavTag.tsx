interface DbDeploymentNavTagProps {
  label: string;
  value: string;
  onClick?: () => void;
  busy?: boolean;
}

export function DbDeploymentNavTag({ label, value, onClick, busy }: DbDeploymentNavTagProps) {
  const clickable = Boolean(onClick) && !busy;
  return (
    <button
      type="button"
      className="db-mysql-deploy-tag db-mysql-deploy-tag--nav"
      title={`${label}: ${value}`}
      disabled={!clickable}
      onClick={clickable ? onClick : undefined}
    >
      {value}
    </button>
  );
}
