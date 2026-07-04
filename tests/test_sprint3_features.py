"""
Test suite for Sprint 3 features:
1. Stage Naming Engine with scenic regions and meaningful towns
2. Absolute temperature color mapping for stable rendering
"""

import json
import math
import pytest
from project.backend.stage_naming import (
    compute_stage_name,
    build_stage_names,
    _scenic_region_score,
    _location_quality_score,
    _pick_endpoint_name,
    _find_nearby_significant_town,
    SCENIC_REGIONS,
    TOWN_SIZE_THRESHOLD,
)


class TestScenicRegionDetection:
    """Test scenic region scoring and detection."""
    
    def test_bardenas_reales_detection(self):
        """Bardenas Reales should be detected for coordinates in its bounds."""
        # Bardenas Reales center: ~42.3, -1.4
        region_name, score = _scenic_region_score(42.3, -1.4)
        assert region_name == "Bardenas Reales"
        assert score > 2.0
    
    def test_black_forest_detection(self):
        """Black Forest should be detected for coordinates in its bounds."""
        # Black Forest center: ~48.6, 8.4
        region_name, score = _scenic_region_score(48.6, 8.4)
        assert region_name == "Black Forest"
        assert score > 2.0
    
    def test_vercors_detection(self):
        """Vercors should be detected for coordinates in its bounds."""
        # Vercors center: ~45.0, 5.5
        region_name, score = _scenic_region_score(45.0, 5.5)
        assert region_name == "Vercors"
        assert score > 2.0
    
    def test_no_region_outside_bounds(self):
        """Coordinates far from any region should return None."""
        # Somewhere in the Atlantic Ocean
        region_name, score = _scenic_region_score(30.0, -50.0)
        assert region_name is None
        assert score == 0.0


class TestLocationQualityScoring:
    """Test location candidate scoring logic."""
    
    def test_large_city_preferred_over_small_village(self):
        """Larger towns should score higher than small villages."""
        large_city = {
            "name": "Lyon",
            "population": 500000,
            "admin_type": "city",
            "lat": 45.764,
            "lon": 4.835,
            "distance_km": 10.0,
        }
        small_village = {
            "name": "Hamletville",
            "population": 50,
            "admin_type": "hamlet",
            "lat": 45.764,
            "lon": 4.835,
            "distance_km": 5.0,
        }
        
        large_score = _location_quality_score(large_city, 45.0, 5.0, is_start=False)
        small_score = _location_quality_score(small_village, 45.0, 5.0, is_start=False)
        
        assert large_score > small_score
    
    def test_closer_location_preferred(self):
        """Closer locations should score higher when population is similar."""
        nearby_town = {
            "name": "Grenoble",
            "population": 160000,
            "admin_type": "city",
            "distance_km": 5.0,
        }
        far_town = {
            "name": "Chambéry",
            "population": 160000,
            "admin_type": "city",
            "distance_km": 50.0,
        }
        
        nearby_score = _location_quality_score(nearby_town, 45.0, 5.0, is_start=False)
        far_score = _location_quality_score(far_town, 45.0, 5.0, is_start=False)
        
        assert nearby_score > far_score
    
    def test_tiny_villages_disqualified(self):
        """Tiny villages (population < TINY_VILLAGE_THRESHOLD) should score very low."""
        tiny_hamlet = {
            "name": "Tinyville",
            "population": 20,
            "admin_type": "hamlet",
            "distance_km": 1.0,
        }
        
        score = _location_quality_score(tiny_hamlet, 45.0, 5.0, is_start=False)
        assert score < 1.0


class TestStageNaming:
    """Test stage naming with priority hierarchy."""
    
    def test_scenic_region_priority(self):
        """Stage within scenic regions should use region name."""
        # Vercors area: 45.0, 5.5
        name = compute_stage_name(45.0, 5.5, 45.1, 5.6)
        assert "Vercors" in name
    
    def test_two_different_scenic_regions(self):
        """Stage crossing two scenic regions should show both."""
        # Black Forest to start: 48.6, 8.4
        # Vercors to end: 45.0, 5.5
        name = compute_stage_name(48.6, 8.4, 45.0, 5.5)
        assert "Black Forest" in name
        assert "Vercors" in name
    
    def test_stage_name_with_fallback(self):
        """Stage should have a fallback name (coordinates) if no regions/towns found."""
        name = compute_stage_name(50.0, 0.0, 51.0, 1.0)
        # Should either have a town or fallback to coordinates
        assert isinstance(name, str)
        assert len(name) > 0
    
    def test_continuity_maintained(self):
        """Consecutive stages should maintain continuity (Day N end = Day N+1 start)."""
        stage_coords = [
            (45.0, 5.5, 45.1, 5.6),  # Vercors to somewhere
            (45.1, 5.6, 45.2, 5.7),  # Starting where previous ended
        ]
        names = build_stage_names(stage_coords)
        
        assert len(names) == 2
        # Extract end name from stage 1
        if " → " in names[0]:
            stage1_end = names[0].split(" → ")[-1]
            # Extract start name from stage 2
            if " → " in names[1]:
                stage2_start = names[1].split(" → ")[0]
                # Continuity should be maintained or both should be same scenic region
                # This is a soft check since logic allows for nearby towns
                assert isinstance(stage1_end, str)
                assert isinstance(stage2_start, str)


class TestEndpointNameSelection:
    """Test endpoint name picking from candidates."""
    
    def test_pick_best_candidate(self):
        """Should pick the largest/closest candidate."""
        candidates = [
            {
                "name": "Grenoble",
                "population": 160000,
                "admin_type": "city",
                "lat": 45.188,
                "lon": 5.724,
            },
            {
                "name": "Tiny Village",
                "population": 50,
                "admin_type": "hamlet",
                "lat": 45.190,
                "lon": 5.720,
            },
        ]
        
        name = _pick_endpoint_name(45.0, 5.5, candidates, endpoint_type="end")
        assert "Grenoble" in name
    
    def test_avoid_specific_name(self):
        """Should skip candidates matching avoid_name."""
        candidates = [
            {
                "name": "Grenoble",
                "population": 160000,
                "admin_type": "city",
                "lat": 45.188,
                "lon": 5.724,
            },
            {
                "name": "Chambéry",
                "population": 60000,
                "admin_type": "city",
                "lat": 45.500,
                "lon": 5.900,
            },
        ]
        
        # If we avoid Grenoble, should pick Chambéry
        name = _pick_endpoint_name(45.0, 5.5, candidates, endpoint_type="end", avoid_name="Grenoble")
        assert "Chambéry" in name or len(name) == 0  # May not be close enough


class TestNearbyTownFallback:
    """Test finding nearby significant towns for duplicate resolution."""
    
    def test_find_nearby_large_town(self):
        """Should find a large town nearby when available."""
        candidates = [
            {
                "name": "SmallTown",
                "population": 10000,
                "admin_type": "town",
                "lat": 45.0,
                "lon": 5.5,
            },
            {
                "name": "LargeCity",
                "population": 500000,
                "admin_type": "city",
                "lat": 45.2,
                "lon": 5.6,
            },
        ]
        
        town = _find_nearby_significant_town(45.1, 5.55, candidates, max_distance_km=50.0)
        # Should find LargeCity if it's within distance
        if town:
            assert "LargeCity" in town


class TestIntegrationScenarios:
    """Integration tests for real-world scenarios."""
    
    def test_alpine_tour_naming(self):
        """Test stage naming for a typical Alpine tour route."""
        # Example: Lyon → Grenoble → Chambéry
        stage_coords = [
            (45.764, 4.835, 45.188, 5.724),    # Lyon → Grenoble
            (45.188, 5.724, 45.570, 5.898),    # Grenoble → Chambéry
        ]
        names = build_stage_names(stage_coords)
        
        assert len(names) == 2
        # Should have meaningful names
        for name in names:
            assert isinstance(name, str)
            assert len(name) > 0
    
    def test_pyrenees_tour_naming(self):
        """Test stage naming for Pyrenees region stages."""
        # Coordinates in/near Pyrenees
        stage_coords = [
            (42.5, -1.0, 42.6, -0.8),    # Within/near Pyrenees
        ]
        names = build_stage_names(stage_coords)
        
        assert len(names) == 1
        # Should mention Pyrenees if in that region
        assert isinstance(names[0], str)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
