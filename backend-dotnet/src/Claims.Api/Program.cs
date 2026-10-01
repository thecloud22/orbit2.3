using Claims.Config;
using Claims.Migrations;
using Claims.Temporal;
using Claims.Web;

var builder = WebApplication.CreateBuilder(args);
if (string.IsNullOrEmpty(builder.Configuration["urls"])) builder.WebHost.UseUrls("http://*:8080");   // the Java version's port; ASPNETCORE_URLS overrides
builder.Configuration.AddClaimsEnvironmentAliases();   // CLAIMS_DB_URL, TEMPORAL_TARGET, ... keep working as before

// Local runs: a real Temporal dev server inside this process (Claims:Temporal:DevServer=true), so no Docker or Homebrew is needed for Temporal.
// It is started before the container is built, so the client, the worker and the Schedule all read its address from configuration.
var temporal = builder.Configuration.GetSection("Claims:Temporal").Get<ClaimsOptions.TemporalOptions>() ?? new ClaimsOptions.TemporalOptions();
if (temporal.Enabled && temporal.DevServer)
{
    if (builder.Environment.IsProduction()) throw new InvalidOperationException("Claims:Temporal:DevServer (an embedded Temporal dev server) is for local runs, never Production");
    Console.WriteLine($"Starting the embedded Temporal dev server on port {temporal.DevServerPort} (the first run downloads the Temporal CLI)...");
    var devServer = await TemporalDevServer.StartAsync(temporal);
    builder.Configuration["Claims:Temporal:Target"] = devServer.Target;
    builder.Services.AddHostedService(_ => new TemporalDevServerLifetime(devServer));
    Console.WriteLine($"Temporal dev server: {devServer.Target}" + (devServer.UiPort is { } ui ? $" · UI http://localhost:{ui}" : ""));
}
builder.Services.AddClaims(builder.Configuration);

var app = builder.Build();

var options = app.Services.GetRequiredService<ClaimsOptions>();
if (options.Dev.Controls && app.Environment.IsProduction())
    throw new InvalidOperationException("Claims:Dev:Controls (the virtual clock) must never be enabled in Production");

if (options.Db.Migrate)
{
    var logger = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Claims.Migrations");
    Migrator.Run(Claims.Common.PgConnection.Build(options.Db.Url, options.Db.User, options.Db.Password), options.Db.DevSeed,
        line => logger.LogInformation("{Migration}", line));
}

app.UseMiddleware<ApiExceptionMiddleware>();
app.MapClaims();
app.MapClaimSubresources();
app.MapRequirements();
app.MapDeadlines();
app.MapWorkItems();
app.MapDecisions();
app.MapPayments();
app.MapDocuments();
app.MapWorkflowRuns();
if (options.Dev.Controls) app.MapDev();   // the virtual clock: routes exist only when Claims:Dev:Controls is true
app.MapGet("/actuator/health", () => Results.Json(new { status = "UP" }));   // what Spring Boot's actuator exposed

app.Run();

/// <summary>Public so the integration tests can host the API with WebApplicationFactory.</summary>
public partial class Program;
