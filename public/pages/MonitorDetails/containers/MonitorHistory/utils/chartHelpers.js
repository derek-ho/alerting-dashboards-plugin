/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { ALERT_STATE } from '../../../../../utils/constants';
import { EMPTY_ALERT_COUNT, TIME_SERIES_ALERT_STATE } from './constants';

export const dataPointsGenerator = ({
  startTime,
  acknowledgedTime,
  endTime,
  lastEndTime,
  windowEndTime,
  meta,
}) => {
  const alertDataPoints = [];

  // Adds not alerting state
  if (lastEndTime) {
    alertDataPoints.push({
      x0: lastEndTime,
      x: startTime,
      state: TIME_SERIES_ALERT_STATE.NO_ALERTS,
      meta: {
        startTime: lastEndTime,
        endTime: startTime,
      },
    });
  }

  if (acknowledgedTime) {
    alertDataPoints.push({
      x0: startTime,
      x: acknowledgedTime < windowEndTime ? acknowledgedTime : windowEndTime,
      state: TIME_SERIES_ALERT_STATE.TRIGGERED,
      meta,
    });
    // If acknowledge time is outside window, ignore the end plotting
    if (acknowledgedTime < windowEndTime) {
      alertDataPoints.push({
        x0: acknowledgedTime,
        x: endTime && endTime < windowEndTime ? endTime : windowEndTime,
        state: TIME_SERIES_ALERT_STATE.ACKNOWLEDGED,
        meta,
      });
    }
  } else {
    alertDataPoints.push({
      x0: startTime,
      x: endTime && endTime < windowEndTime ? endTime : windowEndTime,
      state: TIME_SERIES_ALERT_STATE.TRIGGERED,
      meta,
    });
  }
  return alertDataPoints;
};

export const generateFirstDataPoints = ({
  startTime,
  acknowledgedTime,
  endTime,
  state,
  windowStartTime,
  windowEndTime,
  errorsCount,
}) => {
  const firstAlertData = {
    startTime,
    acknowledgedTime,
    endTime,
    windowStartTime,
    windowEndTime,
    meta: {
      startTime,
      acknowledgedTime,
      endTime,
      state,
      errorsCount,
    },
  };

  /*
    Alert could have started within timeSeriesWindowRange,
    in this case , it should create NOT_ALERTING data point
    for startWindow -> firstAlertTime and then continue creating
    alerts
  */
  if (windowStartTime < firstAlertData.startTime) {
    return dataPointsGenerator({
      ...firstAlertData,
      lastEndTime: windowStartTime,
    });
  }
  // Alert is being continued from previous window, highlight from
  // startOfWindow to end_time / Acknowledge Time
  return dataPointsGenerator({
    ...firstAlertData,
    startTime: windowStartTime,
    acknowledgedTime:
      acknowledgedTime && acknowledgedTime < windowStartTime ? windowStartTime : acknowledgedTime,
    lastEndTime: null,
  });
};

// This generates query for the displaying POI Data from the window with provided duration
export const getPOISearchQuery = (monitorId, startTime, endTime, intervalDuration) => ({
  query: {
    bool: {
      filter: [
        { term: { monitor_id: monitorId } },
        {
          bool: {
            should: [
              { range: { start_time: { gte: startTime, lte: endTime } } },
              { range: { end_time: { gte: startTime, lte: endTime } } },
              {
                bool: {
                  should: [
                    { range: { start_time: { lte: startTime } } },
                    { range: { end_time: { gte: endTime } } },
                    {
                      bool: {
                        must_not: {
                          exists: { field: 'monitor.schedule.period' },
                        },
                      },
                    },
                  ],
                  minimum_should_match: 2,
                },
              },
            ],
            minimum_should_match: 1,
          },
        },
      ],
    },
  },
  aggs: {
    alerts_over_time: {
      date_histogram: {
        interval: `${intervalDuration.asMinutes()}m`,
        extended_bounds: {
          min: startTime,
          max: endTime,
        },
        script: {
          lang: 'painless',
          // Alert start / end time can fall in only in one bucket, but our POI shows the alerts over the time of period.
          // To achieve this below script will return events over the period so it will fall into all buckets from starting to end time for an alert
          source: `def alertsWindow = new ArrayList();
                      def startTime = doc.start_time.value.millis < params.startTime ? params.startTime : doc.start_time.value.millis;
                      def endTime;
                      /*
                        Painless script returns default dateTime epoch for null date fields instead of returning null.
                        In case of alert is in one of the state (ACTIVE / ERROR / ACKNOWLEDGE) end_time can be null.
                        We are setting default end time to window end time.
                        More details can be found here https://github.com/elastic/elasticsearch/pull/30975
                      */

                      if(doc.end_time.size() == 0) {
                        endTime = params.endTime
                      } else {
                        endTime = doc.end_time.value.millis;
                      }
                      while(startTime <= endTime) {
                           alertsWindow.add(startTime);
                           startTime = startTime + params.interval;
                       }
                       return alertsWindow;`,
          params: {
            startTime,
            endTime,
            interval: intervalDuration.asMilliseconds(),
          },
        },
      },
    },
    max_alerts: {
      max_bucket: {
        buckets_path: 'alerts_over_time._count',
      },
    },
  },
});

export const parseGroupedData = (triggerData) => {
  let result = [];
  triggerData.map((data) => {
    if (data.state === TIME_SERIES_ALERT_STATE.NO_ALERTS) result.push(data);
    // Check if result contains other overlapping data and update
    else {
      const foundIndex = result.findIndex((element) => {
        return (
          (element.x0 <= data.x0 || element.x >= data.x) &&
          element.state !== TIME_SERIES_ALERT_STATE.NO_ALERTS
        );
      });
      const state = data.state;
      if (foundIndex < 0) {
        //  If state is not no alert, push the item with initial count
        let dataToPush = {
          ...data,
          state: TIME_SERIES_ALERT_STATE.TRIGGERED,
          meta: { ...data.meta, ...EMPTY_ALERT_COUNT },
        };
        dataToPush.meta[state]++;
        result.push(dataToPush);
      } else {
        // Update the grouped data with new state count and start, end time
        const prevData = result[foundIndex];
        result.splice(foundIndex, 1, {
          ...prevData,
          x0: Math.min(prevData.x0, data.x0),
          x: Math.max(prevData.x, data.x),
          meta: {
            ...prevData.meta,
            startTime: Math.min(prevData.meta.startTime, data.meta.startTime),
            [state]: prevData.meta[state] + 1,
          },
        });
      }
    }
  });
  return result;
};
