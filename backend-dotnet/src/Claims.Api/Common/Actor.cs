namespace Claims.Common;

/// <summary>Who made a change, recorded on history events. Authentication is not built; see README.</summary>
public sealed record Actor(string Kind, string Name)
{
    public static Actor User(string name) => new("user", name);
    public static Actor System(string name) => new("system", name);
    public static Actor Workflow(string workflowId) => new("workflow", workflowId);
    public static Actor Batch(string name) => new("batch", name);
}
