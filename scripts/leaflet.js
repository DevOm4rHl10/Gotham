
var map = L.map('map').setView([51.505, -0.09], 13);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);




async function fetchCrimesAndNeighbourhoods() {
    const [crimesRes, neighbourhoodsRes] = await Promise.all([
        fetch('/data/crimes_2025-01.json'),
        fetch('/data/all_neighbourhoods.json')
    ]);

    const crimesData = await crimesRes.json();
    const neighbourhoodsData = await neighbourhoodsRes.json();

    // crimesData.crimes contains all crime records
    // neighbourhoodsData is your neighbourhood list
    return { crimes: crimesData.crimes, neighbourhoods: neighbourhoodsData };
}


function buildNeighbourhoodLookup(neighbourhoods) {
    const lookup = {};
    neighbourhoods.forEach(n => {
        lookup[n.neighbourhood_id] = n.force_id;
    });
    return lookup;
}


function annotateCrimesWithForce(crimes, neighbourhoodLookup) {
    return crimes.map(crime => {
        const force_id = neighbourhoodLookup[crime.neighbourhood_id] || "unknown";
        return { ...crime, force_id };
    });
}



function groupCrimesByForce(crimes) {
    const grouped = {};

    crimes.forEach(crime => {
        if (!grouped[crime.force_id]) grouped[crime.force_id] = [];
        grouped[crime.force_id].push(crime);
    });

    return grouped;
}



/*
//Main test function
async function testGrouping() {
    const { crimes, neighbourhoods } = await fetchCrimesAndNeighbourhoods();

    const neighbourhoodLookup = buildNeighbourhoodLookup(neighbourhoods);
    const annotatedCrimes = annotateCrimesWithForce(crimes, neighbourhoodLookup);
    const groupedCrimes = groupCrimesByForce(annotatedCrimes);

    console.log("All grouped crimes by force:", groupedCrimes);

    // Example: log all crimes under 'lancashire'
    console.log("Crimes for lancashire:", groupedCrimes["lancashire"]);

    // Example: show how many crimes each force has
    for (const force_id in groupedCrimes) {
        console.log(`${force_id}: ${groupedCrimes[force_id].length} incidents`);
    }
}

// Call it
testGrouping();
*/


async function addCrimeClusters(map) {
    // Fetch data
    const { crimes, neighbourhoods } = await fetchCrimesAndNeighbourhoods();

    // Build lookup and annotate crimes
    const neighbourhoodLookup = buildNeighbourhoodLookup(neighbourhoods);
    const annotatedCrimes = annotateCrimesWithForce(crimes, neighbourhoodLookup);

    // Create MarkerClusterGroup
    const markers = L.markerClusterGroup();

    // Add markers for each crime
    annotatedCrimes.forEach(crime => {
        if (crime.lat && crime.lng) { // skip invalid coordinates
            const marker = L.marker([crime.lat, crime.lng])
                .bindPopup(`
                    <b>${crime.category}</b><br>
                    ${crime.street_name}<br>
                    <i>Force: ${crime.force_id}</i>
                `);
            markers.addLayer(marker);
        }
    });

    // Add cluster layer to map
    map.addLayer(markers);
}


addCrimeClusters(map);





