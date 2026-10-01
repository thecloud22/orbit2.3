namespace Claims.Domain;

/// <summary>requested -> received -> accepted; not_enough goes back to being chased; waived needs a reason; expired.</summary>
public enum RequirementState { Requested, Received, Accepted, NotEnough, Waived, Expired }

public static class RequirementStateExtensions
{
    /// <summary>Met = accepted or waived; proof of loss is complete when every requirement is met.</summary>
    public static bool Met(this RequirementState s) => s is RequirementState.Accepted or RequirementState.Waived;

    /// <summary>Still worth chasing: nothing has arrived, or what arrived was not enough.</summary>
    public static bool Chasing(this RequirementState s) => s is RequirementState.Requested or RequirementState.NotEnough;
}
