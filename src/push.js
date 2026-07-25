export const buildPayload = (state) => {
  const { data, sensors } = state;
  const feed = {};
  if (typeof data.temperature_internal === "number") feed.Internal_Temperature = [{ value: data.temperature_internal }];
  if (typeof data.humidity_internal === "number") feed.Internal_Humidity = [{ value: data.humidity_internal }];
  if (typeof data.temperature_external === "number") feed.External_Temperature = [{ value: data.temperature_external }];
  feed.External_Status = [{ value: sensors.external_status }];
  if (sensors.external_diagnostic != null) feed.External_Diagnostic = [{ value: sensors.external_diagnostic }];
  return { data: feed };
};

export const pushData = async (axiosInstance, { feedId, key }, state) => {
  if (!key) return null;
  return axiosInstance.post(`https://iotplotter.com/api/v2/feed/${feedId}`, buildPayload(state), {
    headers: { "api-key": key },
  });
};
