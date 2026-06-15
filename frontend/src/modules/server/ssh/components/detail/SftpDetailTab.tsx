import { SftpPanel } from "../../../../../components/sftp";

type Props = {
  activeResource: { id: string } | null;
};

export function SftpDetailTab({ activeResource }: Props) {
  return <SftpPanel resourceId={activeResource?.id ?? null} />;
}
