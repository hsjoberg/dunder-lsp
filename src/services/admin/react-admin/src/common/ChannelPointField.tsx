import { Link } from "@material-ui/core";

export function channelPointField(channelPoint: any) {
  if (!channelPoint) {
    return <>N/A</>;
  }

  const tx = channelPoint.split(":")[0];

  return <Link href={`http://mempool.space/tx/${tx}`}>{channelPoint}</Link>;
}
