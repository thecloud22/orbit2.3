using System.Reflection;
using Xunit.Sdk;
using Xunit.v3;

namespace Claims.Tests.Support;

/// <summary>Runs the tests of a class in this order (used only by the end-to-end flow test, whose steps build on each other).</summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class OrderAttribute(int order) : Attribute
{
    public int Order { get; } = order;
}

public sealed class OrderAttributeOrderer : ITestCaseOrderer
{
    public IReadOnlyCollection<TTestCase> OrderTestCases<TTestCase>(IReadOnlyCollection<TTestCase> testCases) where TTestCase : notnull, ITestCase =>
        testCases.OrderBy(tc => tc is IXunitTestCase x ? x.TestMethod.Method.GetCustomAttribute<OrderAttribute>()?.Order ?? int.MaxValue : int.MaxValue).ToList();
}
