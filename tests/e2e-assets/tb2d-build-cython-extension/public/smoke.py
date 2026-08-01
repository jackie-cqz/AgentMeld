from agentmeld_faststats import mean64


value = mean64([1.0, 2.0, 6.0])
assert abs(value - 3.0) < 1e-12
print(value)

