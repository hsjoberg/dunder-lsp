import React, { useEffect, useState } from "react";
import { Card, CardHeader, CardContent, CircularProgress } from "@material-ui/core";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { format, subDays, addDays } from "date-fns";

import { IChannelRequest, IHtlcSettlement } from "../interface/interface";

interface TotalByDay {
  date: number;
  total: number;
}

interface IHtlcSettlementExtended extends IHtlcSettlement {
  start: number;
}

const lastDay = new Date();
const lastMonthDays = Array.from({ length: 30 }, (_, i) => subDays(lastDay, i));
const aMonthAgo = subDays(new Date(), 30);

const dateFormatter = (date: number): string => new Date(date).toLocaleDateString();

const aggregateChannelRequestsByDay = (
  channelRequests: IHtlcSettlementExtended[],
): { [key: string]: number } =>
  channelRequests
    // .filter((order) => order.status === "DONE")
    .reduce((acc, curr) => {
      const day = format(curr.start * 1000, "yyyy-MM-dd");
      if (!acc[day]) {
        acc[day] = 0;
      }
      acc[day] += 1;
      return acc;
    }, {} as { [key: string]: number });

const getRevenuePerDay = (channelRequests: IHtlcSettlementExtended[]): TotalByDay[] => {
  const daysWithRevenue = aggregateChannelRequestsByDay(channelRequests);
  return lastMonthDays.map((date) => ({
    date: date.getTime(),
    total: daysWithRevenue[format(date, "yyyy-MM-dd")] || 0,
  }));
};

export interface IHtlcSettlementProps {
  channelRequests?: IChannelRequest[];
  htlcSettlements?: IHtlcSettlement[];
}
const HtlcSettlementChart: React.FunctionComponent<IHtlcSettlementProps> = ({
  channelRequests,
  htlcSettlements,
}) => {
  const [htlcSettlementsExtended, setHtlcSettlements] = useState<
    IHtlcSettlementExtended[] | undefined
  >(undefined);

  useEffect(() => {
    (async () => {
      if (channelRequests && htlcSettlements) {
        setHtlcSettlements(
          htlcSettlements.map((htlcSettlement) => {
            const htlcSettlementExtended: IHtlcSettlementExtended = {
              ...htlcSettlement,
              start:
                channelRequests.find(
                  (channelRequest) => channelRequest.channelId === htlcSettlement.channelId,
                )?.start ?? 0,
            };
            return htlcSettlementExtended;
          }),
        );
      }
    })();
  }, [htlcSettlements]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card>
      <CardHeader title={"HTLC settlements"} />
      <CardContent>
        <div style={{ width: "99%", height: 300, ...center }}>
          {(!channelRequests || !htlcSettlementsExtended) && <CircularProgress />}
          {channelRequests && htlcSettlementsExtended && (
            <ResponsiveContainer>
              <AreaChart data={getRevenuePerDay(htlcSettlementsExtended)}>
                <defs>
                  <linearGradient id="colorUv" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#8884d8" stopOpacity={0.8} />
                    <stop offset="95%" stopColor="#8884d8" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="date"
                  name="Date"
                  type="number"
                  scale="time"
                  domain={[addDays(aMonthAgo, 1).getTime(), new Date().getTime()]}
                  tickFormatter={dateFormatter}
                />
                <YAxis dataKey="total" allowDecimals={false} name="Channel openings" />
                <CartesianGrid strokeDasharray="3 3" />
                <Tooltip cursor={{ strokeDasharray: "3 3" }} />
                <Area dataKey="total" stroke="#8884d8" strokeWidth={2} fill="url(#colorUv)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

const center: React.CSSProperties = {
  width: "99%",
  height: 300,
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
};

export default HtlcSettlementChart;
