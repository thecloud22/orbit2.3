namespace Claims.Domain;

public enum DeadlineState { Open, Dispatched, Done, Skipped }

public static class DeadlineStateExtensions
{
    public static bool Live(this DeadlineState s) => s is DeadlineState.Open or DeadlineState.Dispatched;
}
