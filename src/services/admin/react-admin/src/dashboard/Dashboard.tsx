import { CSSProperties, useEffect, useState } from "react";
import { useDataProvider, useVersion, Link } from "react-admin";
import { Card, CardHeader, CardContent, Typography, CircularProgress } from "@material-ui/core";
import { format } from "date-fns";

import ChannelRequestChart from "./ChannelRequestChart";
import HtlcSettlementChart from "./HtlcSettlementChart";
import { IChannelRequest, IHtlcSettlement } from "../interface/interface";

const styles: { [key: string]: CSSProperties } = {
  flex: { display: "flex", marginBottom: 10 },
  flexColumn: { display: "flex", flexDirection: "column" },
  leftCol: { flex: 1, marginRight: 5 },
  rightCol: { flex: 1, marginLeft: 5 },
};

const Dashboard = () => {
  const version = useVersion();

  const [channelRequests, setChannelRequests] = useState<IChannelRequest[] | undefined>(undefined);
  const [htlcSettlements, setHtlcSettlements] = useState<IHtlcSettlement[] | undefined>(undefined);
  const [noRequestsToday, setNoRequestsToday] = useState<number | undefined>(undefined);
  const [noOpeningsToday, setNoOpeningsToday] = useState<number | undefined>(undefined);
  const [noExpirationsToday, setNoExpirationsToday] = useState<number | undefined>(undefined);
  const [totalSatsOpened, setTotalSatsOpened] = useState<number | undefined>(undefined);
  const [noUnclaimedButSettledHtlcs, setNoUnclaimedButSettledHtlcs] = useState<number | undefined>(
    undefined,
  );
  const dataProvider = useDataProvider();

  useEffect(() => {
    (async () => {
      const channelRequestResult = await dataProvider.getList<IChannelRequest>("channelRequests", {
        filter: {},
        sort: { field: "start", order: "DESC" },
        pagination: { page: 1, perPage: 100000 },
      });
      setChannelRequests(channelRequestResult.data);

      const htlcSettlementResult = await dataProvider.getList<IHtlcSettlement>("htlcSettlements", {
        filter: {},
        sort: { field: "start", order: "DESC" },
        pagination: { page: 1, perPage: 100000 },
      });
      setHtlcSettlements(htlcSettlementResult.data);

      const todayResult = await dataProvider.getList<IChannelRequest>("channelRequests", {
        filter: { custom_days: [format(new Date(), "yyyy-MM-dd")] },
        sort: { field: "start", order: "DESC" },
        pagination: { page: 1, perPage: 100000 },
      });

      setNoRequestsToday(todayResult.data.length);

      const openings = todayResult.data.reduce((prev, curr) => {
        return prev + (curr.status === "DONE" ? 1 : 0);
      }, 0);
      setNoOpeningsToday(openings);

      const expirations = todayResult.data.reduce((prev, curr) => {
        return prev + (curr.expired ? 1 : 0);
      }, 0);
      setNoExpirationsToday(expirations);

      const totalSats = todayResult.data.reduce((prev, curr) => {
        return prev + (curr.status === "DONE" ? curr.expectedAmountSat : 0);
      }, 0);
      setTotalSatsOpened(totalSats);

      const unclaimedButSettledHtlcs = htlcSettlementResult.data.reduce((prev, curr) => {
        return prev + (curr.settled && !curr.claimed ? 1 : 0);
      }, 0);
      setNoUnclaimedButSettledHtlcs(unclaimedButSettledHtlcs);
    })();

    return () => {
      setChannelRequests(undefined);
      setHtlcSettlements(undefined);
      setNoRequestsToday(undefined);
      setNoOpeningsToday(undefined);
      setNoExpirationsToday(undefined);
      setTotalSatsOpened(undefined);
      setNoUnclaimedButSettledHtlcs(undefined);
    };
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  const htlcSettlementsUnclaimedButSettledLink = {
    pathname: "htlcSettlements",
    search: encodeURI(`?displayedFilters={"unclaimedButSettled":1}`),
  } as any;

  return (
    <>
      <Card style={{ marginTop: 10, marginBottom: 10 }}>
        <CardHeader title="Welcome to Dunder administration" />
      </Card>

      {noUnclaimedButSettledHtlcs !== undefined && noUnclaimedButSettledHtlcs > 0 && (
        <div style={styles.flex}>
          <div style={styles.leftCol}>
            <Card>
              <CardHeader title={"WARNING: Number of settled but unclaimed HTLCs"} />
              <CardContent style={{ height: 110 }}>
                <Link to={htlcSettlementsUnclaimedButSettledLink}>
                  <Typography align="center" variant="h2" component="h2" color="error">
                    {noUnclaimedButSettledHtlcs}
                  </Typography>
                </Link>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      <div style={styles.flex}>
        <div style={styles.leftCol}>
          <div style={{ ...styles.flex, marginBottom: 0 }}>
            <div style={styles.leftCol}>
              <Card>
                <CardHeader title={"Requests total today"} />
                <CardContent style={{ height: 110 }}>
                  <Typography align="center" variant="h2" component="h2">
                    {noRequestsToday && noRequestsToday}
                    {noRequestsToday === undefined && <CircularProgress style={loadingStyle} />}
                  </Typography>
                </CardContent>
              </Card>
            </div>
            <div style={styles.rightCol}>
              <Card>
                <CardHeader title={"Openings today"} />
                <CardContent style={{ height: 110 }}>
                  <Typography align="center" variant="h2" component="h2">
                    {noOpeningsToday && noOpeningsToday}
                    {noOpeningsToday === undefined && <CircularProgress style={loadingStyle} />}
                  </Typography>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
        <div style={styles.rightCol}>
          <div style={{ ...styles.flex, marginBottom: 0 }}>
            <div style={styles.leftCol}>
              <Card>
                <CardHeader title={"Expirations today"} />
                <CardContent style={{ height: 110 }}>
                  <Typography align="center" variant="h2" component="h2">
                    {noExpirationsToday && noExpirationsToday}
                    {noExpirationsToday === undefined && <CircularProgress style={loadingStyle} />}
                  </Typography>
                </CardContent>
              </Card>
            </div>
            <div style={styles.rightCol}>
              <Card>
                <CardHeader title={"Sats opened today"} />
                <CardContent style={{ height: 110 }}>
                  <Typography align="center" variant="h2" component="h2">
                    {totalSatsOpened && totalSatsOpened.toLocaleString()}
                    {totalSatsOpened === undefined && <CircularProgress style={loadingStyle} />}
                  </Typography>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </div>

      <div style={styles.flex}>
        <div style={styles.leftCol}>
          <ChannelRequestChart channelRequests={channelRequests} />
        </div>
        <div style={styles.rightCol}>
          <HtlcSettlementChart
            channelRequests={channelRequests}
            htlcSettlements={htlcSettlements}
          />
        </div>
      </div>
    </>
  );
};

const loadingStyle: React.CSSProperties = { display: "block", margin: "auto" };

export default Dashboard;
