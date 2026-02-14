import numpy as np
from sklearn.cluster import HDBSCAN
from load import X
import collections


# Convert lat/lng to radians for haversine metric
X_rad = np.radians(X)

# Clusterer
clusterer = HDBSCAN(
    min_cluster_size=20,                # smallest meaningful cluster
    cluster_selection_epsilon=250 / 1000 / 6371.0088,  # 250 meters in radians  (     WTF IS METER IN RADIAN MR CHATGPT!!!!)    )
    metric='haversine'
)

# Fit and get cluster labels
labels = clusterer.fit_predict(X_rad)

# Check results
print(collections.Counter(labels))





"""
# Evaluate clusters
sc = metrics.silhouette_score(X, labels)
print("Silhouette Coefficient:%0.2f" % sc)
ari = adjusted_rand_score(y_true, labels)
print("Adjusted Rand Index: %0.2f" % ari)

"""

