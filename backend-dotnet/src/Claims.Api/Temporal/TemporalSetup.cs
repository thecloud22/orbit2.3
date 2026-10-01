using Claims.Common;
using Claims.Config;
using Temporalio.Client;
using Temporalio.Converters;

namespace Claims.Temporal;

/// <summary>
/// Connects to the org's Temporal (we own a namespace and task queues, not a cluster). For a real namespace add TLS / API-key options
/// in <see cref="ClientOptions"/>; local dev talks plain gRPC to the dev server. The client is created lazily (no connect until first use), as the Java stubs were: the
/// API starts even when Temporal is down, and the outbox relay and the dispatcher back off and retry.
/// </summary>
public static class TemporalSetup
{
    public static TemporalClientConnectOptions ClientOptions(ClaimsOptions.TemporalOptions t) => new(t.Target)
    {
        Namespace = t.Namespace,
        DataConverter = DataConverterFor(),
    };

    /// <summary>Creates the client without connecting (no network I/O): the first call connects.</summary>
    public static ITemporalClient CreateClient(ClaimsOptions.TemporalOptions t) => TemporalClient.CreateLazy(ClientOptions(t));

    /// <summary>Payloads are JSON in the same camelCase shape Jackson produced, so both backends read each other's workflow history.</summary>
    public static DataConverter DataConverterFor() =>
        DataConverter.Default with { PayloadConverter = new DefaultPayloadConverter(Json.Create()) };
}
